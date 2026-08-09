/**
 * Runtime WebSocket smoke test for the ACP server transport.
 *
 * Earlier WS tests stub the socket (fake sink / fake global WebSocket). This
 * one uses a REAL `ws` server and the REAL Node global `WebSocket` client via
 * `ACPSession.connectWebSocket`, so actual bytes cross a real socket through
 * `WsBridgeTransport` → `ACPProtocolHandler` and back. Proves the live
 * `wstack acp --ws` wiring works, not just its parts.
 */

import { ACPSession } from '@wrongstack/acp';
import { ACPProtocolHandler, type RunTurn, WsBridgeTransport } from '@wrongstack/acp/agent';
import { afterEach, describe, expect, it } from 'vitest';
import { type WebSocket, WebSocketServer } from 'ws';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  // LIFO: close the client (session) before the server, otherwise
  // wss.close() blocks waiting for the still-connected client.
  for (const c of cleanups.splice(0).reverse()) await c();
});

describe('wstack acp --ws runtime', () => {
  it('serves a real WebSocket connection and runs a prompt turn end-to-end', async () => {
    const echoTurn: RunTurn = async (input, emit) => {
      const text = (input.prompt[0] as { text?: string })?.text ?? '';
      emit({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `echo: ${text}` },
      });
      return { stopReason: 'end_turn' };
    };

    // Real ws server on an ephemeral port — wire one handler per connection
    // exactly like runACPWebSocketServer does. Use the constructor's listening
    // callback to avoid racing the 'listening' event.
    const wss = await new Promise<WebSocketServer>((resolve) => {
      const s: WebSocketServer = new WebSocketServer({ host: '127.0.0.1', port: 0 }, () =>
        resolve(s),
      );
    });
    cleanups.push(() => new Promise<void>((r) => wss.close(() => r())));
    wss.on('connection', (socket: WebSocket) => {
      const transport = new WsBridgeTransport((m) => socket.send(JSON.stringify(m)));
      const handler = new ACPProtocolHandler({
        transport,
        defaultCwd: process.cwd(),
        runTurn: echoTurn,
      });
      socket.on('message', (data: Buffer) => {
        let msg: unknown;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }
        transport.receive(msg as never);
        void handler.handleMessage(msg);
      });
      socket.on('close', () => {
        handler.close();
        transport.close();
      });
    });

    const addr = wss.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    expect(port).toBeGreaterThan(0);

    // Real client over a real WebSocket.
    const session = await ACPSession.connectWebSocket(
      { url: `ws://127.0.0.1:${port}` },
      { command: 'ws', projectRoot: process.cwd(), timeoutMs: 10_000 },
    );
    cleanups.push(() => session.close());

    expect(session.getAgentInfo()?.name).toBe('wrongstack');

    const result = await session.prompt(
      [{ type: 'text', text: 'ping' }],
      new AbortController().signal,
    );
    expect(result.text).toBe('echo: ping');
    expect(result.stopReason).toBe('end_turn');
  }, 20_000);
});
