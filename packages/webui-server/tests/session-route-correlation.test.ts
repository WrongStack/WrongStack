import { describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { handleSessionRoute, type SessionRouteHandlers } from '../src/server/session-routes.js';

describe('session context acknowledgement routing', () => {
  it('correlates context mutation results and failures for the asking desktop operation', async () => {
    const sent: Record<string, unknown>[] = [];
    const socket = {
      readyState: 1,
      send: (data: string) => sent.push(JSON.parse(data)),
    } as unknown as WebSocket;
    const handlers = {
      compactContext: async (ws: WebSocket) => {
        ws.send(
          JSON.stringify({
            type: 'key.operation_result',
            payload: { success: false, message: 'Compactor unavailable' },
          }),
        );
      },
      repairContext: async (ws: WebSocket) => {
        ws.send(
          JSON.stringify({
            type: 'key.operation_result',
            payload: { success: true, message: 'Repaired' },
          }),
        );
      },
    } as unknown as SessionRouteHandlers;
    await handleSessionRoute(
      socket,
      {
        type: 'context.compact',
        payload: { requestId: 'compact-a', sessionId: 'session-a' },
      } as never,
      handlers,
    );
    await handleSessionRoute(
      socket,
      {
        type: 'context.repair',
        payload: { requestId: 'repair-b', sessionId: 'session-b' },
      } as never,
      handlers,
    );
    expect(sent).toEqual([
      {
        type: 'key.operation_result',
        payload: { success: false, message: 'Compactor unavailable', requestId: 'compact-a' },
      },
      {
        type: 'key.operation_result',
        payload: { success: true, message: 'Repaired', requestId: 'repair-b' },
      },
    ]);
  });
  it('correlates context editor validation and apply replies with the asking request', async () => {
    const sent: Record<string, unknown>[] = [];
    const socket = {
      readyState: 1,
      send: (data: string) => sent.push(JSON.parse(data)),
    } as unknown as WebSocket;
    const reply = (ws: WebSocket, type: string, payload: Record<string, unknown>) =>
      ws.send(JSON.stringify({ type, payload }));
    const handlers = {
      validateContextEditor: async (ws: WebSocket) =>
        reply(ws, 'context.editor.validation', { ok: true, sessionId: 'session-a' }),
      applyContextEditor: async (ws: WebSocket) => {
        reply(ws, 'context.editor.validation', { ok: false, sessionId: 'session-a' });
        reply(ws, 'key.operation_result', { success: true, message: 'applied' });
      },
    } as unknown as SessionRouteHandlers;
    await handleSessionRoute(
      socket,
      { type: 'context.editor.validate', payload: { requestId: 'validate-a' } } as never,
      handlers,
    );
    await handleSessionRoute(
      socket,
      { type: 'context.editor.apply', payload: { requestId: 'apply-b' } } as never,
      handlers,
    );
    expect(
      sent.map((frame) => [
        frame['type'],
        (frame['payload'] as Record<string, unknown>)['requestId'],
      ]),
    ).toEqual([
      ['context.editor.validation', 'validate-a'],
      ['context.editor.validation', 'apply-b'],
      ['key.operation_result', 'apply-b'],
    ]);
  });
  it('preserves the original socket and payload for legacy context requests', async () => {
    const socket = { readyState: 1 } as WebSocket;
    let actual: WebSocket | undefined;
    const handlers = {
      debugContext: async (ws: WebSocket) => {
        actual = ws;
      },
    } as unknown as SessionRouteHandlers;
    await handleSessionRoute(socket, { type: 'context.debug', payload: {} } as never, handlers);
    expect(actual).toBe(socket);
  });
});
