import type { WSClientMessage } from '@wrongstack/webui-server';
import { handleMailboxRoute, type MailboxRouteHandlers } from '@wrongstack/webui-server';
import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';

function mockWs(): WebSocket & { send: ReturnType<typeof vi.fn> } {
  return { readyState: 1, send: vi.fn() } as never as WebSocket & {
    send: ReturnType<typeof vi.fn>;
  };
}

function sentMessages(ws: { send: ReturnType<typeof vi.fn> }): unknown[] {
  return ws.send.mock.calls.map(([raw]) => JSON.parse(String(raw)) as unknown);
}

function handlers(): MailboxRouteHandlers {
  return {
    action: vi.fn(),
    messages: vi.fn(),
    agents: vi.fn(),
    clear: vi.fn(),
    purge: vi.fn(),
    send: vi.fn(),
    compact: vi.fn(),
  };
}

describe('handleMailboxRoute', () => {
  it('returns false for non-mailbox messages and does not send', async () => {
    const ws = mockWs();
    const h = handlers();

    await expect(
      handleMailboxRoute(ws, { type: 'chat.ready', payload: {} } as WSClientMessage, h),
    ).resolves.toBe(false);

    expect(h.messages).not.toHaveBeenCalled();
    expect(h.agents).not.toHaveBeenCalled();
    expect(h.clear).not.toHaveBeenCalled();
    expect(h.purge).not.toHaveBeenCalled();
    expect(sentMessages(ws)).toEqual([]);
  });

  it.each([
    ['mailbox.messages', 'messages'],
    ['mailbox.agents', 'agents'],
    ['mailbox.clear', 'clear'],
    ['mailbox.purge', 'purge'],
  ] as const)('dispatches %s to %s', async (type, handlerName) => {
    const ws = mockWs();
    const h = handlers();
    const msg = { type, payload: { limit: 10 } } as never as WSClientMessage;

    await expect(handleMailboxRoute(ws, msg, h)).resolves.toBe(true);

    expect(h[handlerName]).toHaveBeenCalledTimes(1);
  });

  it('forwards the original message object to payload-bearing handlers', async () => {
    const ws = mockWs();
    const h = handlers();
    const msg = {
      type: 'mailbox.purge',
      payload: { completedMaxAgeMs: 1 },
    } as never as WSClientMessage;

    await expect(handleMailboxRoute(ws, msg, h)).resolves.toBe(true);

    expect(h.purge).toHaveBeenCalledWith(ws, msg);
    expect(sentMessages(ws)).toEqual([]);
  });
});
