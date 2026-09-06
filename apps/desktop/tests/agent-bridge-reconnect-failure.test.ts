/**
 * Regression tests for unhandled promise rejections from fire-and-forget
 * reconnect connects in `DesktopAgentBridge`.
 *
 * Two production paths start a connect() with no caller to receive a
 * rejection:
 *   1. the automatic reconnect timer in `scheduleReconnect()`
 *   2. `forceReconnect()` (user-triggered, returns void)
 *
 * connect()'s error path already records status/error and schedules the next
 * attempt, so the floating rejection is pure fallout — but pre-fix it surfaced
 * as a process-level `unhandledRejection` on every failed reconnect against a
 * dead runtime, which can terminate the Electron main process.
 *
 * Both tests kill a real server mid-session and assert the failure is
 * absorbed by the reconnect state machine instead of the process.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { DesktopAgentBridge } from '../src/main/agent-bridge.js';

interface ProofServer {
  url: string;
  /** Stop accepting, drop live sockets, and wait for the server to close. */
  kill: () => Promise<void>;
}

async function startServer(): Promise<ProofServer> {
  const httpServer: Server = createServer();
  const wss = new WebSocketServer({ server: httpServer });
  await new Promise<void>((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => resolve());
  });
  const url = `ws://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  const kill = () =>
    new Promise<void>((resolve) => {
      for (const client of wss.clients) client.terminate();
      wss.close(() => resolve());
      httpServer.close(() => resolve());
      // Belt-and-braces: never hang the test on a lingering handle.
      setTimeout(() => resolve(), 500).unref?.();
    });
  return { url, kill };
}

/** Resolve on the bridge's first failure 'reconnect' event. */
function onceReconnectFailed(bridge: DesktopAgentBridge): Promise<void> {
  return new Promise<void>((resolve) => {
    bridge.on('reconnect', (event: { status: string }) => {
      if (event.status === 'error') resolve();
    });
  });
}

describe('agent-bridge fire-and-forget reconnect absorption', () => {
  it('scheduled reconnect failure does not raise an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    const bridge = new DesktopAgentBridge();
    try {
      const server = await startServer();
      await bridge.ensureConnected('rt-scheduled', server.url);
      await server.kill();

      // Wait until the automatic (timer-fired) reconnect attempt has failed.
      await Promise.race([
        onceReconnectFailed(bridge),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error('scheduled reconnect never fired')), 8000),
        ),
      ]);
      // One event-loop beat for any rejection to be reported.
      await new Promise<void>((resolve) => setTimeout(resolve, 200));

      expect(
        unhandled,
        `scheduled reconnect produced unhandled rejection(s): ${unhandled
          .map((r) => String(r))
          .join(' | ')}`,
      ).toEqual([]);
    } finally {
      bridge.closeAll();
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('forceReconnect failure does not raise an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    const bridge = new DesktopAgentBridge();
    try {
      const server = await startServer();
      await bridge.ensureConnected('rt-force', server.url);
      await server.kill();

      // User-triggered reconnect returns void: a dead runtime must not turn
      // into an unhandled rejection in the main process.
      bridge.forceReconnect('rt-force', server.url);

      await Promise.race([
        onceReconnectFailed(bridge),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error('forceReconnect never failed')), 8000),
        ),
      ]);
      await new Promise<void>((resolve) => setTimeout(resolve, 200));

      expect(
        unhandled,
        `forceReconnect produced unhandled rejection(s): ${unhandled
          .map((r) => String(r))
          .join(' | ')}`,
      ).toEqual([]);
    } finally {
      bridge.closeAll();
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
