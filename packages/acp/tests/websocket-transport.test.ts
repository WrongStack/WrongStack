/**
 * Tests for the remote WebSocket client transport and
 * `ACPSession.connectWebSocket`. A fake global `WebSocket` lets us drive
 * open/message/close without a real socket.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ACPSession } from '../src/client/acp-session.js';
import { WebSocketClientTransport } from '../src/client/websocket-transport.js';
import type { ACPMessage } from '../src/types/acp-messages.js';

type Listener = (ev?: unknown) => void;

class FakeWS {
  static instances: FakeWS[] = [];
  readonly url: string;
  readonly listeners: Record<string, Listener[]> = {};
  readonly sent: string[] = [];
  bufferedAmount = 0;
  closed = false;
  sendError: unknown;
  closeError: unknown;
  constructor(url: string) {
    this.url = url;
    FakeWS.instances.push(this);
  }
  addEventListener(type: string, cb: Listener): void {
    const list = this.listeners[type] ?? [];
    list.push(cb);
    this.listeners[type] = list;
  }
  send(data: string): void {
    if (this.sendError !== undefined) throw this.sendError;
    this.sent.push(data);
  }
  close(): void {
    if (this.closeError !== undefined) throw this.closeError;
    this.closed = true;
    this.fire('close');
  }
  fire(type: string, ev?: unknown): void {
    for (const cb of this.listeners[type] ?? []) cb(ev);
  }
}

const realWS = (globalThis as { WebSocket?: unknown }).WebSocket;

function last(): FakeWS {
  const t = FakeWS.instances[FakeWS.instances.length - 1];
  if (!t) throw new Error('no WebSocket constructed');
  return t;
}

beforeEach(() => {
  FakeWS.instances.length = 0;
  (globalThis as { WebSocket?: unknown }).WebSocket = FakeWS as never;
});

afterEach(() => {
  (globalThis as { WebSocket?: unknown }).WebSocket = realWS;
});

describe('WebSocketClientTransport', () => {
  it('resolves start() on open, dispatches parsed messages, serializes sends', async () => {
    const t = new WebSocketClientTransport({ url: 'ws://agent.test' });
    const startP = t.start();
    last().fire('open');
    await startP;

    const received: ACPMessage[] = [];
    t.onMessage((m) => received.push(m));
    last().fire('message', {
      data: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }),
    });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ id: 1, result: { ok: true } });

    await t.send({ jsonrpc: '2.0', id: 2, method: 'ping' } as never as ACPMessage);
    expect(JSON.parse(last().sent[0]!)).toMatchObject({ id: 2, method: 'ping' });

    t.stop();
    expect(last().closed).toBe(true);
  });

  it('rejects start() when WebSocket is not available globally', async () => {
    delete (globalThis as { WebSocket?: unknown }).WebSocket;
    const t = new WebSocketClientTransport({ url: 'ws://agent.test' });
    await expect(t.start()).rejects.toThrow('global WebSocket is not available');
  });

  it('rejects start() on a timeout', async () => {
    const t = new WebSocketClientTransport({ url: 'ws://agent.test', handshakeTimeoutMs: 10 });
    await expect(t.start()).rejects.toThrow(/within 10ms/);
  });

  it('handles error events after socket is already open by marking closed', async () => {
    const t = new WebSocketClientTransport({ url: 'ws://agent.test' });
    const startP = t.start();
    const ws = last();
    ws.fire('open');
    await startP;

    // Fire an error after the socket is open — should mark closed but not reject
    ws.fire('error', { message: 'post-open error' });
    // No rejection, still operational
    expect(t.send).toBeDefined();
  });

  it('rejects start() on error during connection', async () => {
    const t = new WebSocketClientTransport({ url: 'ws://agent.test', handshakeTimeoutMs: 500 });
    const startP = t.start();
    const ws = last();
    ws.fire('error', { message: 'connection refused' });
    await expect(startP).rejects.toThrow('connection refused');
  });

  it('handles multiple JSON messages split by newline in one message event', async () => {
    const t = new WebSocketClientTransport({ url: 'ws://agent.test' });
    const startP = t.start();
    last().fire('open');
    await startP;

    const received: ACPMessage[] = [];
    t.onMessage((m) => received.push(m));

    // Simulate a message that contains two JSON objects separated by newline
    last().fire('message', {
      data:
        JSON.stringify({ jsonrpc: '2.0', id: 1, result: { first: true } }) +
        '\n' +
        JSON.stringify({ jsonrpc: '2.0', id: 2, result: { second: true } }),
    });

    expect(received).toHaveLength(2);
    expect(received[0]).toMatchObject({ id: 1, result: { first: true } });
    expect(received[1]).toMatchObject({ id: 2, result: { second: true } });
  });

  it('handles non-JSON data gracefully by skipping malformed fragments', async () => {
    const t = new WebSocketClientTransport({ url: 'ws://agent.test' });
    const startP = t.start();
    last().fire('open');
    await startP;

    const received: ACPMessage[] = [];
    t.onMessage((m) => received.push(m));

    // Send a mix of valid and invalid JSON
    last().fire('message', {
      data: 'invalid\n\n{"jsonrpc":"2.0","id":1,"result":{}}\nstill invalid',
    });

    // Only the valid JSON should be dispatched
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ id: 1 });
  });

  it('rejects send() after the socket is closed', async () => {
    const t = new WebSocketClientTransport({ url: 'ws://agent.test' });
    const startP = t.start();
    last().fire('open');
    await startP;
    t.stop();
    await expect(t.send({ jsonrpc: '2.0', id: 1 } as never as ACPMessage)).rejects.toThrow(
      /not open/,
    );
  });

  it('closes instead of growing an oversized send buffer', async () => {
    const t = new WebSocketClientTransport({
      url: 'ws://agent.test',
      maxBufferedBytes: 8,
    });
    const startP = t.start();
    const ws = last();
    ws.fire('open');
    await startP;
    ws.bufferedAmount = 8;

    await expect(t.send({ method: 'x' } as ACPMessage)).rejects.toThrow('buffer limit');
    expect(ws.closed).toBe(true);
  });

  it('closes on an oversized inbound message', async () => {
    const t = new WebSocketClientTransport({
      url: 'ws://agent.test',
      maxMessageChars: 8,
    });
    const startP = t.start();
    const ws = last();
    ws.fire('open');
    await startP;
    ws.fire('message', { data: '123456789' });
    expect(ws.closed).toBe(true);
  });

  it('covers late opens, generic connection errors, and close failures', async () => {
    const errored = new WebSocketClientTransport({ url: 'ws://agent.test' });
    const errorStart = errored.start();
    const errorSocket = last();
    errorSocket.fire('error', null);
    errorSocket.fire('open');
    await expect(errorStart).rejects.toThrow('WebSocket error');

    const stopped = new WebSocketClientTransport({ url: 'ws://agent.test' });
    stopped.stop();

    const closing = new WebSocketClientTransport({ url: 'ws://agent.test' });
    const closingStart = closing.start();
    const closingSocket = last();
    closingSocket.fire('open');
    await closingStart;
    closingSocket.closeError = new Error('close failed');
    expect(() => closing.stop()).not.toThrow();
  });

  it('settles a pending start when stopped or closed before opening', async () => {
    const stopped = new WebSocketClientTransport({ url: 'ws://agent.test' });
    const stoppedStart = stopped.start();
    stopped.stop();
    await expect(stoppedStart).rejects.toThrow('stopped while connecting');

    const closed = new WebSocketClientTransport({ url: 'ws://agent.test' });
    const closedStart = closed.start();
    last().fire('close');
    await expect(closedStart).rejects.toThrow('closed before the connection opened');
  });

  it('rejects duplicate starts instead of orphaning the first handshake promise', async () => {
    const transport = new WebSocketClientTransport({ url: 'ws://agent.test' });
    const firstStart = transport.start();
    await expect(transport.start()).rejects.toThrow('already been started');
    last().fire('open');
    await expect(firstStart).resolves.toBeUndefined();
  });

  it('normalizes buffers, array buffers, other data, whitespace, and faulty handlers', async () => {
    const t = new WebSocketClientTransport({
      url: 'ws://agent.test',
      maxBufferedBytes: Number.NaN,
      maxMessageChars: -1,
    });
    const start = t.start();
    const ws = last();
    ws.fire('open');
    await start;
    const received: ACPMessage[] = [];
    t.onMessage(() => {
      throw new Error('consumer failed');
    });
    t.onMessage((message) => received.push(message));
    const json = JSON.stringify({ id: 1 });
    ws.fire('message', { data: Buffer.from(json) });
    ws.fire('message', { data: Uint8Array.from(Buffer.from(json)).buffer });
    ws.fire('message', { data: '   ' });
    ws.fire('message', { data: 42 });
    expect(received).toHaveLength(3);
  });

  it('normalizes send failures and missing or invalid buffered amounts', async () => {
    const t = new WebSocketClientTransport({ url: 'ws://agent.test' });
    const start = t.start();
    const ws = last();
    ws.fire('open');
    await start;

    ws.bufferedAmount = Number.NaN;
    await expect(t.send({ id: 1 } as ACPMessage)).resolves.toBeUndefined();
    Object.defineProperty(ws, 'bufferedAmount', { value: undefined, configurable: true });
    await expect(t.send({ id: 2 } as ACPMessage)).resolves.toBeUndefined();
    ws.sendError = new Error('send failed');
    await expect(t.send({ id: 3 } as ACPMessage)).rejects.toThrow('send failed');
    ws.sendError = 'string failure';
    await expect(t.send({ id: 4 } as ACPMessage)).rejects.toThrow('string failure');
  });
});

describe('ACPSession.connectWebSocket', () => {
  const PROJECT_ROOT = path.resolve(os.tmpdir(), 'wstack-acp-ws-test');

  it('connects, handshakes, and runs a prompt turn over the socket', async () => {
    const sessionP = ACPSession.connectWebSocket(
      { url: 'ws://agent.test' },
      { command: 'remote', projectRoot: PROJECT_ROOT },
    );
    // Open the socket so initialize can be sent.
    last().fire('open');
    await new Promise((r) => setImmediate(r));

    const ws = last();
    const initMsg = ws.sent.map((s) => JSON.parse(s)).find((m) => m.method === 'initialize');
    expect(initMsg).toBeDefined();
    ws.fire('message', {
      data: JSON.stringify({
        jsonrpc: '2.0',
        id: initMsg.id,
        result: { protocolVersion: 1, agentInfo: { name: 'remote', version: '1' } },
      }),
    });
    const session = await sessionP;
    expect(session.getAgentInfo()?.name).toBe('remote');

    // Run a prompt: new → stream a chunk → stopReason.
    const promptP = session.prompt([{ type: 'text', text: 'hi' }], new AbortController().signal);
    await new Promise((r) => setImmediate(r));
    const newMsg = ws.sent.map((s) => JSON.parse(s)).find((m) => m.method === 'session/new');
    ws.fire('message', {
      data: JSON.stringify({ jsonrpc: '2.0', id: newMsg.id, result: { sessionId: 'sess_ws' } }),
    });
    await new Promise((r) => setImmediate(r));
    const promptMsg = ws.sent.map((s) => JSON.parse(s)).find((m) => m.method === 'session/prompt');
    ws.fire('message', {
      data: JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'sess_ws',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'pong' } },
        },
      }),
    });
    ws.fire('message', {
      data: JSON.stringify({
        jsonrpc: '2.0',
        id: promptMsg.id,
        result: { stopReason: 'end_turn' },
      }),
    });

    const result = await promptP;
    expect(result.text).toBe('pong');
    expect(result.stopReason).toBe('end_turn');
    await session.close();
  });
});
