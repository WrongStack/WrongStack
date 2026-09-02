import type { WebSocket } from 'ws';
import { describe, expect, it, vi } from 'vitest';
import { handleBrainRoute, type BrainRouteHandlers } from '@wrongstack/webui-server';
import type { WSClientMessage } from '@wrongstack/webui-server';

function mockWs(): WebSocket & { send: ReturnType<typeof vi.fn> } {
  return { readyState: 1, send: vi.fn() } as never as WebSocket & {
    send: ReturnType<typeof vi.fn>;
  };
}

function sentMessages(ws: { send: ReturnType<typeof vi.fn> }): unknown[] {
  return ws.send.mock.calls.map(([raw]) => JSON.parse(String(raw)) as unknown);
}

function handlers(): BrainRouteHandlers {
  return {
    status: vi.fn(),
    risk: vi.fn(),
    ask: vi.fn(),
  };
}

describe('handleBrainRoute', () => {
  it('returns false for non-brain messages and does not send', async () => {
    const ws = mockWs();
    const h = handlers();

    await expect(
      handleBrainRoute(ws, { type: 'chat.ready', payload: {} } as WSClientMessage, h),
    ).resolves.toBe(false);

    expect(h.status).not.toHaveBeenCalled();
    expect(h.risk).not.toHaveBeenCalled();
    expect(h.ask).not.toHaveBeenCalled();
    expect(sentMessages(ws)).toEqual([]);
  });

  it.each([
    ['brain.status', 'status'],
    ['brain.risk', 'risk'],
    ['brain.ask', 'ask'],
  ] as const)('dispatches %s to %s', async (type, handlerName) => {
    const ws = mockWs();
    const h = handlers();
    const msg = { type, payload: { question: 'What next?' } } as never as WSClientMessage;

    await expect(handleBrainRoute(ws, msg, h)).resolves.toBe(true);

    expect(h[handlerName]).toHaveBeenCalledTimes(1);
  });

  it('forwards original payload-bearing messages', async () => {
    const ws = mockWs();
    const h = handlers();
    const msg = { type: 'brain.ask', payload: { question: 'Explain' } } as never as WSClientMessage;

    await expect(handleBrainRoute(ws, msg, h)).resolves.toBe(true);

    expect(h.ask).toHaveBeenCalledWith(ws, msg);
    expect(sentMessages(ws)).toEqual([]);
  });
});
