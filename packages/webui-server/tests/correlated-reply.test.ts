import { describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { correlatedReply } from '../src/server/correlated-reply.js';

function socket() {
  const frames: string[] = [];
  const ws = {
    readyState: 1,
    send(this: unknown, value: string) {
      if (this !== ws) throw new Error('Native socket receiver was lost');
      frames.push(value);
    },
  };
  return { ws: ws as unknown as WebSocket, frames };
}
describe('correlated direct replies', () => {
  it('stamps the selected operation while preserving the original socket receiver', () => {
    const { ws, frames } = socket();
    const reply = correlatedReply(ws, { requestId: 'memory-map-1' }, ['kanban.create']);
    reply.socket.send(
      JSON.stringify({
        type: 'kanban.create',
        payload: { success: true, data: { title: 'Roadmap' } },
      }),
    );
    expect(JSON.parse(frames[0]!)).toMatchObject({
      payload: { requestId: 'memory-map-1', success: true, data: { title: 'Roadmap' } },
    });
    expect(reply.replied).toBe(true);
  });
  it('does not stamp broadcasts or the next request on the same connection', () => {
    const { ws, frames } = socket();
    const first = correlatedReply(ws, { requestId: 'first' }, ['mcp.operation_result']);
    const second = correlatedReply(ws, { requestId: 'second' }, ['mcp.operation_result']);
    first.socket.send(JSON.stringify({ type: 'mcp.list', payload: { servers: [] } }));
    second.socket.send(
      JSON.stringify({
        type: 'mcp.operation_result',
        payload: { success: false, message: 'Invalid endpoint' },
      }),
    );
    expect(JSON.parse(frames[0]!).payload.requestId).toBeUndefined();
    expect(JSON.parse(frames[1]!).payload.requestId).toBe('second');
    expect(first.replied).toBe(false);
    expect(second.replied).toBe(true);
  });
  it('preserves older clients that have no request identity', () => {
    const { ws } = socket();
    expect(correlatedReply(ws, {}, ['prefs.updated']).socket).toBe(ws);
  });
  it('stamps only the first matching reply and passes through non-JSON or null frames safely', () => {
    const { ws, frames } = socket();
    const reply = correlatedReply(ws, { requestId: 'once-only' }, ['mcp.operation_result']);
    reply.socket.send('plain-text');
    reply.socket.send('null');
    reply.socket.send(JSON.stringify({ type: 'mcp.operation_result', payload: { success: true } }));
    reply.socket.send(
      JSON.stringify({ type: 'mcp.operation_result', payload: { success: false } }),
    );
    expect(frames[0]).toBe('plain-text');
    expect(frames[1]).toBe('null');
    expect(JSON.parse(frames[2]!).payload.requestId).toBe('once-only');
    expect(JSON.parse(frames[3]!).payload.requestId).toBeUndefined();
  });
});
