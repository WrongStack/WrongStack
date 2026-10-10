import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { BrainDecision, BrainDecisionRequest } from '@wrongstack/core/coordination';
import { expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from '../src/ws-runtime.js';
import type { BrainHandlerContext } from '../src/server/brain-handlers.js';
import { createBrainRouteHandlers, handleBrainRoute } from '../src/server/brain-routes.js';

it('correlates out-of-order success and failure replies over a real WebSocket', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const pending: Array<{
    request: BrainDecisionRequest;
    resolve: (decision: BrainDecision) => void;
    reject: (error: Error) => void;
  }> = [];
  const failures: unknown[] = [];
  let currentSession = 'host-at-start';
  const ctx: BrainHandlerContext = {
    send: (ws, message) => ws.send(JSON.stringify(message)),
    brainSettings: undefined,
    getBrainLog: undefined,
    getSessionId: () => currentSession,
    resolveArbiter: () => ({
      decide: (request) =>
        new Promise((resolve, reject) => pending.push({ request, resolve, reject })),
    }),
  };
  const routes = createBrainRouteHandlers(ctx);
  server.on('connection', (ws) =>
    ws.on('message', (raw) => {
      void handleBrainRoute(ws, JSON.parse(String(raw)), routes).catch((error) =>
        failures.push(error),
      );
    }),
  );
  let client: WebSocket | undefined;
  try {
    await once(server, 'listening');
    client = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`);
    const replies: Array<{ type: string; payload: Record<string, unknown> }> = [];
    client.on('message', (raw) => replies.push(JSON.parse(String(raw))));
    await once(client, 'open');
    for (const [requestId, sessionId] of [
      ['first', 'alpha'],
      ['second', 'beta'],
    ]) {
      client.send(
        JSON.stringify({
          type: 'brain.ask',
          payload: { question: 'Same question?', requestId, sessionId },
        }),
      );
    }
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    expect(pending[0]?.request.id).not.toBe(pending[1]?.request.id);
    currentSession = 'host-now-points-elsewhere';
    pending[1]!.reject(new Error('second provider unavailable'));
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    pending[0]!.resolve({ type: 'answer', text: 'First request completed' });
    await vi.waitFor(() => expect(replies).toHaveLength(2));
    expect(replies[0]).toMatchObject({
      type: 'key.operation_result',
      payload: { requestId: 'second', sessionId: 'beta', success: false },
    });
    expect(replies[1]).toMatchObject({
      type: 'brain.answer',
      payload: {
        requestId: 'first',
        sessionId: 'alpha',
        decision: { text: 'First request completed' },
      },
    });
    client.send(
      JSON.stringify({
        type: 'brain.ask',
        payload: { question: '', requestId: 'invalid', sessionId: 'alpha' },
      }),
    );
    await vi.waitFor(() => expect(replies).toHaveLength(3));
    expect(replies[2]?.payload).toMatchObject({
      requestId: 'invalid',
      sessionId: 'alpha',
      success: false,
    });
    expect(pending).toHaveLength(2);
    expect(failures).toEqual([]);
  } finally {
    client?.terminate();
    for (const connection of server.clients) connection.terminate();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
