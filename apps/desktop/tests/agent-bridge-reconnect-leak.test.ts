/**
 * Verifies the fix for the persistent `ws.on('message', …)` listener leak.
 *
 * RAM-leak audit 2026-08-11, HIGH: `connect()` registered the message handler
 * with `.on()` (persistent) while every other handler used `.once()`. The
 * closure pinned `ConversationInternal` (and its `messages[]`) until the socket
 * was GC'd. The fix: a named `onMessage` handler, detached in `close()` and in
 * the socket's own `close` event via `ws.off('message', onMessage)`.
 *
 * This test uses a real `ws.WebSocketServer` and the real
 * `DesktopAgentBridge`. `ws` WebSocket instances extend `EventEmitter`, so
 * `ws.listeners('message').length` tells us exactly how many message handlers
 * are attached — no monkey-patching needed.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type WebSocket, WebSocketServer } from 'ws';
import { DesktopAgentBridge } from '../src/main/agent-bridge.js';

describe('agent-bridge message listener cleanup', () => {
  let httpServer: Server;
  let wss: WebSocketServer;
  let port: number;

  beforeAll(
    () =>
      new Promise<void>((resolve) => {
        httpServer = createServer();
        wss = new WebSocketServer({ server: httpServer });
        httpServer.listen(0, '127.0.0.1', () => {
          port = (httpServer.address() as AddressInfo).port;
          resolve();
        });
      }),
  );

  afterAll(
    () =>
      new Promise<void>((resolve) => {
        wss.close();
        httpServer.close(() => resolve());
      }),
  );

  it('detaches the message listener on close()', async () => {
    const bridge = new DesktopAgentBridge();
    const url = `ws://127.0.0.1:${port}`;

    await bridge.ensureConnected('runtime-1', url);

    // Grab the live WebSocket from the bridge's internal conversation record.
    const conversation = (
      bridge as unknown as {
        conversations: Map<string, { ws: WebSocket | null }>;
      }
    ).conversations.get('runtime-1');

    expect(conversation).toBeDefined();
    expect(conversation!.ws).not.toBeNull();

    // After a successful connect, exactly ONE message listener should exist.
    const ws = conversation!.ws!;
    expect(ws.listeners('message')).toHaveLength(1);

    // Close the runtime. The fix detaches the named handler synchronously
    // BEFORE calling ws.close() — so the listener count drops to 0
    // immediately, not waiting for the socket's own asynchronous close event.
    bridge.close('runtime-1');

    expect(ws.listeners('message')).toHaveLength(0);

    bridge.closeAll();
  });

  it('does not accumulate message listeners across reconnect cycles', async () => {
    const bridge = new DesktopAgentBridge();
    const url = `ws://127.0.0.1:${port}`;
    const cycles = 20;

    for (let i = 0; i < cycles; i++) {
      const rt = `rt-${i}`;
      await bridge.ensureConnected(rt, url);
      bridge.close(rt);
    }

    // After 20 connect→close cycles, no conversation records should remain.
    const conversations = (bridge as unknown as { conversations: Map<string, unknown> })
      .conversations;
    expect(conversations.size).toBe(0);

    bridge.closeAll();
  });

  it('connects immediately for a user send while a delayed reconnect is pending', async () => {
    const bridge = new DesktopAgentBridge();
    const url = `ws://127.0.0.1:${port}`;
    await bridge.ensureConnected('runtime-send', url);

    const conversation = (
      bridge as unknown as {
        conversations: Map<
          string,
          { ws: WebSocket | null; reconnectTimer: ReturnType<typeof setTimeout> | null }
        >;
      }
    ).conversations.get('runtime-send');
    if (!conversation?.ws) throw new Error('Expected an open runtime socket');

    conversation.ws.close();
    await new Promise<void>((resolve) => conversation.ws?.once('close', () => resolve()));
    expect(conversation.reconnectTimer).not.toBeNull();

    await expect(
      bridge.sendMessage('runtime-send', url, 'send during retry'),
    ).resolves.toMatchObject({
      runtimeId: 'runtime-send',
      messages: expect.arrayContaining([expect.objectContaining({ text: 'send during retry' })]),
    });

    bridge.closeAll();
  });

  it('coalesces concurrent ensureConnected calls into a single WebSocket', async () => {
    // Regression for H1: `conversation.connectPromise` was declared and
    // cleared on settle but never assigned the in-flight connect() promise,
    // so the dedup branch in `ensureConnected` was dead. Two parallel
    // calls each constructed a fresh WebSocket; the loser's close-handler
    // guard `if (conversation.ws === ws)` meant the superseded socket was
    // never closed — one orphaned OPEN socket per race until close().
    // The fix captures the in-flight promise and assigns it to
    // `conversation.connectPromise`, so the second caller awaits the
    // first and only one WebSocket reaches the server.
    const bridge = new DesktopAgentBridge();
    const url = `ws://127.0.0.1:${port}`;

    await Promise.all([
      bridge.ensureConnected('runtime-coalesce', url),
      bridge.ensureConnected('runtime-coalesce', url),
    ]);

    // Allow the server-side `connection` event to register the accepted
    // socket before we sample. Without this small wait the assertion
    // races the server accept loop (the client-side promise resolves on
    // `open`, the server-side `connection` handler fires shortly after).
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    // With the fix: exactly one WebSocket constructed → wss.clients.size
    // is 1. Without the fix: two parallel WebSockets → wss.clients.size
    // is 2 and this assertion fails.
    expect(wss.clients.size).toBe(1);

    const conversation = (
      bridge as unknown as {
        conversations: Map<string, { ws: WebSocket | null }>;
      }
    ).conversations.get('runtime-coalesce');
    expect(conversation).toBeDefined();
    expect(conversation!.ws).not.toBeNull();

    bridge.closeAll();
  });
});
