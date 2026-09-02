import type { WebSocket } from 'ws';
import { describe, expect, it, vi } from 'vitest';
import { handleModeRoute, type ModeRouteHandlers } from '@wrongstack/webui-server';

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
