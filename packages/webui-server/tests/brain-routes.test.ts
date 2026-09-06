import type { BrainArbiter } from '@wrongstack/core/coordination';
import {
  type BrainRouteHandlers,
  handleBrainRoute,
  type WSClientMessage,
  type WSServerMessage,
} from '@wrongstack/webui-server';
import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { type BrainHandlerContext, handleBrainAsk } from '../src/server/brain-handlers.js';

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

describe('handleBrainAsk payload shape', () => {
  function makeCtx(getSessionId: () => string | undefined): BrainHandlerContext {
    const decision = { type: 'proceed', text: 'ok' };
    const arbiter = {
      decide: vi.fn(async () => decision),
    } as never as BrainArbiter;
    return {
      send: (target: WebSocket, message: WSServerMessage) => target.send(JSON.stringify(message)),
      brainSettings: undefined,
      getBrainLog: undefined,
      resolveArbiter: () => arbiter,
      getSessionId,
    } as never as BrainHandlerContext;
  }

  function findBrainAnswer(ws: {
    send: ReturnType<typeof vi.fn>;
  }): { payload?: Record<string, unknown> } | undefined {
    return sentMessages(ws).find(
      (message) => (message as { type?: string }).type === 'brain.answer',
    ) as { payload?: Record<string, unknown> } | undefined;
  }

  // Key-omission must be pinned by key presence, not value: toEqual cannot
  // distinguish an absent sessionId from one explicitly set to '' — and ''
  // is precisely the regression being guarded against (the client's
  // isActiveSessionMessage gate is fail-closed on present-but-empty).
  it('omits the sessionId key when getSessionId returns empty', async () => {
    const ws = mockWs();
    await handleBrainAsk(
      makeCtx(() => ''),
      ws,
      'What next?',
    );
    const answer = findBrainAnswer(ws);
    expect(answer).toBeDefined();
    expect(Object.hasOwn(answer?.payload ?? {}, 'sessionId')).toBe(false);
  });

  it('stamps sessionId when a session is bound', async () => {
    const ws = mockWs();
    await handleBrainAsk(
      makeCtx(() => 'sess-1'),
      ws,
      'What next?',
    );
    const answer = findBrainAnswer(ws);
    expect(answer).toBeDefined();
    expect(Object.hasOwn(answer?.payload ?? {}, 'sessionId')).toBe(true);
    expect(answer?.payload?.['sessionId']).toBe('sess-1');
  });
});
