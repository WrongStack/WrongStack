import type { WebSocket } from 'ws';
import { describe, expect, it, vi } from 'vitest';
import {
  createModeRouteHandlers,
  handleModeRoute,
  type ModeRouteHandlers,
} from '@wrongstack/webui-server';

function mockWs() {
  return {
    readyState: 1,
    send: vi.fn(),
  } as never as WebSocket & { send: ReturnType<typeof vi.fn> };
}

function sentMessages(ws: ReturnType<typeof mockWs>) {
  return ws.send.mock.calls.map(([raw]) => JSON.parse(String(raw)) as { type: string; payload: Record<string, unknown> });
}

function handlers(): ModeRouteHandlers {
  return {
    listModes: vi.fn(async () => undefined),
    switchMode: vi.fn(async () => undefined),
  };
}

describe('handleModeRoute dispatcher characterization', () => {
  it('returns false and does not send for non-mode message types', async () => {
    const ws = mockWs();
    const h = handlers();

    await expect(handleModeRoute(ws, { type: 'git.info', payload: {} }, h)).resolves.toBe(false);

    expect(ws.send).not.toHaveBeenCalled();
  });

  it.each([
    ['modes.list', 'listModes'],
    ['mode.switch', 'switchMode'],
  ] as const)('dispatches %s to %s and returns true', async (type, handlerName) => {
    const ws = mockWs();
    const h = handlers();
    const msg = { type, payload: { id: 'default' } };

    await expect(handleModeRoute(ws, msg, h)).resolves.toBe(true);

    expect(h[handlerName]).toHaveBeenCalledTimes(1);
    if (handlerName === 'listModes') {
      expect(h[handlerName]).toHaveBeenCalledWith(ws);
    } else {
      expect(h[handlerName]).toHaveBeenCalledWith(ws, msg);
    }
  });

  it('does not invoke any other handler when one type is dispatched', async () => {
    const ws = mockWs();
    const h = handlers();

    await handleModeRoute(ws, { type: 'modes.list', payload: {} }, h);

    expect(h.listModes).toHaveBeenCalledTimes(1);
    expect(h.switchMode).not.toHaveBeenCalled();
  });

  it('dispatches malformed mode.switch payload to switchMode for callback-level validation', async () => {
    const ws = mockWs();
    const h = handlers();
    const msg = { type: 'mode.switch', payload: { id: 123 } };

    await expect(handleModeRoute(ws, msg, h)).resolves.toBe(true);

    expect(h.switchMode).toHaveBeenCalledWith(ws, msg);
    expect(sentMessages(ws)).toEqual([]);
  });

  it('dispatches mode.switch with the original message object', async () => {
    const ws = mockWs();
    const h = handlers();
    const msg = { type: 'mode.switch', payload: { id: 'planner' } };

    await handleModeRoute(ws, msg, h);

    expect(h.switchMode).toHaveBeenCalledWith(ws, msg);
  });

  it('does not send any messages for a valid dispatch when the handler is a no-op stub', async () => {
    const ws = mockWs();
    const h = handlers();

    await handleModeRoute(ws, { type: 'mode.switch', payload: { id: 'default' } }, h);

    expect(sentMessages(ws)).toEqual([]);
  });
});

/**
 * `mode.switch` carries the id of the tab that switched, and three consumers
 * inside `createModeOperations` need it: the meta write, the `mode_changed`
 * journal entry, and `afterSwitch` — which rebuilds the system prompt and is
 * the one that matters most. All three were declared to take a sessionId; the
 * call site passed it to only ONE of them, so on every host the journal entry
 * and the prompt rebuild landed on whichever session the runtime was pointing
 * at. The comment inside the standalone `afterSwitch` describes exactly the
 * bug it could not prevent: "rebuilding it here would swap a different
 * conversation's system prompt".
 */
describe('mode.switch — the switching tab is named to every consumer', () => {
  function modeStore(id: string) {
    return {
      getActiveMode: vi.fn(async () => ({ id: 'default' })),
      setActiveMode: vi.fn(async () => undefined),
      getMode: vi.fn(async (wanted: string) => (wanted === id ? { id } : null)),
      listModes: vi.fn(async () => [{ id }]),
    };
  }

  it('passes the sessionId to applyModeId, getSession and afterSwitch', async () => {
    const applyModeId = vi.fn();
    const afterSwitch = vi.fn(async () => undefined);
    const getSession = vi.fn(() => ({ append: vi.fn(async () => undefined) }));
    const routes = createModeRouteHandlers({
      modeStore: modeStore('focus') as never,
      applyModeId,
      afterSwitch,
      getSession,
      send: vi.fn(),
    });

    await routes.switchMode(mockWs(), {
      type: 'mode.switch',
      payload: { id: 'focus', sessionId: 'sess_bg' },
    } as never);

    expect(applyModeId).toHaveBeenCalledWith('focus', 'sess_bg');
    expect(getSession).toHaveBeenCalledWith('sess_bg');
    expect(afterSwitch).toHaveBeenCalledWith('focus', 'sess_bg');
  });

  it('leaves the sessionId undefined when the client did not name one', async () => {
    const applyModeId = vi.fn();
    const afterSwitch = vi.fn(async () => undefined);
    const routes = createModeRouteHandlers({
      modeStore: modeStore('focus') as never,
      applyModeId,
      afterSwitch,
      send: vi.fn(),
    });

    await routes.switchMode(mockWs(), {
      type: 'mode.switch',
      payload: { id: 'focus' },
    } as never);

    expect(applyModeId).toHaveBeenCalledWith('focus', undefined);
    expect(afterSwitch).toHaveBeenCalledWith('focus', undefined);
  });
});
