import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { DesktopAgentBridge } from '../src/main/agent-bridge.js';
import { WebSocketServer } from './ws-runtime.js';

async function startEndpoint() {
  const httpServer = createServer();
  const wss = new WebSocketServer({ server: httpServer });
  let connections = 0;
  let onMessage: (() => void) | undefined;
  let onClose: (() => void) | undefined;
  wss.on('connection', (socket) => {
    connections++;
    socket.on('message', () => onMessage?.());
    socket.once('close', () => onClose?.());
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  return {
    url: `ws://127.0.0.1:${(httpServer.address() as AddressInfo).port}`,
    get connections() {
      return connections;
    },
    nextMessage: () =>
      new Promise<void>((resolve) => {
        onMessage = resolve;
      }),
    nextClose: () =>
      new Promise<void>((resolve) => {
        onClose = resolve;
      }),
    drop() {
      for (const socket of wss.clients) socket.terminate();
    },
    async stop() {
      for (const socket of wss.clients) socket.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

async function startDelayedFailure() {
  const httpServer = createServer();
  let rejectUpgrade = () => {};
  const upgradeReceived = new Promise<void>((resolve) => {
    httpServer.on('upgrade', (_request, socket) => {
      rejectUpgrade = () =>
        socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      resolve();
    });
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  return {
    url: `ws://127.0.0.1:${(httpServer.address() as AddressInfo).port}`,
    upgradeReceived,
    rejectUpgrade: () => rejectUpgrade(),
    stop: () => new Promise<void>((resolve) => httpServer.close(() => resolve())),
  };
}

describe('DesktopAgentBridge runtime endpoint changes', () => {
  it('reuses the same endpoint, then sends to a new endpoint without stale close effects', async () => {
    const first = await startEndpoint();
    const second = await startEndpoint();
    const bridge = new DesktopAgentBridge();
    try {
      await bridge.ensureConnected('runtime', first.url);
      await bridge.ensureConnected('runtime', first.url);
      expect(first.connections).toBe(1);

      const firstClosed = first.nextClose();
      const firstMessage = first.nextMessage().then(() => 'old');
      const secondMessage = second.nextMessage().then(() => 'new');
      await bridge.sendMessage('runtime', second.url, 'current runtime');
      expect(await Promise.race([firstMessage, secondMessage])).toBe('new');
      expect(second.connections).toBe(1);
      await firstClosed;
      expect(bridge.snapshot('runtime').status).toBe('running');
      expect(bridge.getReconnectStatus('runtime')?.attempt).toBe(0);
    } finally {
      bridge.closeAll();
      await first.stop();
      await second.stop();
    }
  });

  it('uses the new endpoint even if the previous connection fails mid-handshake', async () => {
    const first = await startDelayedFailure();
    const second = await startEndpoint();
    const bridge = new DesktopAgentBridge();
    try {
      const oldConnect = bridge.ensureConnected('runtime', first.url).catch(() => undefined);
      await first.upgradeReceived;
      const secondMessage = second.nextMessage();
      const send = bridge.sendMessage('runtime', second.url, 'new endpoint despite old failure');
      first.rejectUpgrade();
      await oldConnect;
      await send;
      await secondMessage;
      expect(second.connections).toBe(1);
    } finally {
      bridge.closeAll();
      await first.stop();
      await second.stop();
    }
  });

  it('retains the new target when replacing a pending reconnect', async () => {
    const first = await startEndpoint();
    const second = await startEndpoint();
    const bridge = new DesktopAgentBridge();
    const nextEvent = (status: string) =>
      new Promise<void>((resolve) => {
        const listener = (event: { status: string }) => {
          if (event.status !== status) return;
          bridge.off('reconnect', listener);
          resolve();
        };
        bridge.on('reconnect', listener);
      });
    try {
      await bridge.ensureConnected('runtime', first.url);
      const firstScheduled = nextEvent('scheduled');
      first.drop();
      await firstScheduled;

      const secondMessage = second.nextMessage();
      await bridge.sendMessage('runtime', second.url, 'switch during backoff');
      await secondMessage;
      const secondConnectedAgain = nextEvent('connected');
      second.drop();
      await secondConnectedAgain;
      expect(first.connections).toBe(1);
      expect(second.connections).toBe(2);
    } finally {
      bridge.closeAll();
      await first.stop();
      await second.stop();
    }
  });
});
