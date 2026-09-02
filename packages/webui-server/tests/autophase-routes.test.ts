import type { WebSocket } from 'ws';
import { describe, expect, it, vi } from 'vitest';
import { handleGoalRoute, type GoalRouteHandlers } from '@wrongstack/webui-server';
import type { WSClientMessage } from '@wrongstack/webui-server';

function mockWs(): WebSocket & { send: ReturnType<typeof vi.fn> } {
  return { readyState: 1, send: vi.fn() } as never as WebSocket & {
    send: ReturnType<typeof vi.fn>;
  };
}

function sentMessages(ws: { send: ReturnType<typeof vi.fn> }): unknown[] {
  return ws.send.mock.calls.map(([raw]) => JSON.parse(String(raw)) as unknown);
}

function handlers(): GoalRouteHandlers {
  return {
    handleMessage: vi.fn(),
  };
}

describe('handleGoalRoute', () => {
  it('returns false for non-goal messages and does not send', async () => {
    const ws = mockWs();
    const h = handlers();

    await expect(
      handleGoalRoute(ws, { type: 'chat.ready', payload: {} } as WSClientMessage, h),
    ).resolves.toBe(false);

    expect(h.handleMessage).not.toHaveBeenCalled();
    expect(sentMessages(ws)).toEqual([]);
  });

  it('dispatches goal-prefixed messages', async () => {
    const ws = mockWs();
    const h = handlers();
    const msg = { type: 'goal.start', payload: { graphId: 'g1' } } as never as WSClientMessage;

    await expect(handleGoalRoute(ws, msg, h)).resolves.toBe(true);

    expect(h.handleMessage).toHaveBeenCalledWith(ws, msg);
    expect(sentMessages(ws)).toEqual([]);
  });

  it('dispatches unknown goal-prefixed messages to the Goal handler', async () => {
    const ws = mockWs();
    const h = handlers();
    const msg = { type: 'goal.custom', payload: { value: 1 } } as never as WSClientMessage;

    await expect(handleGoalRoute(ws, msg, h)).resolves.toBe(true);

    expect(h.handleMessage).toHaveBeenCalledWith(ws, msg);
  });
});
