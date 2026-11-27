import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { handleHqUpgrade } from '../src/hq-server/upgrade-handler.js';

function makeSocket() {
  let destroyed = false;
  return {
    write() {},
    destroy() {
      destroyed = true;
    },
    isDestroyed: () => destroyed,
  } as unknown as Duplex & { isDestroyed(): boolean };
}

describe('handleHqUpgrade URL parsing (F2717)', () => {
  const baseDeps = {
    host: '127.0.0.1',
    port: 3000,
    mutableAuth: {
      passwordHash: undefined,
      cookieSecret: undefined,
      browserTokens: new Set<string>(),
      clientTokens: new Set<string>(),
      browserTokenObjs: new Map(),
      clientTokenObjs: new Map(),
    },
    sessions: new Map(),
    clients: new Map(),
    browsers: new Set(),
    snapshotBroadcaster: { broadcast: () => {}, scheduleBroadcast: () => {} } as never,
    wss: {} as never,
  };

  it('handles IPv6 bind hosts and malformed req.url without throwing', () => {
    for (const [host, url] of [
      ['::1', '/unknown'],
      ['::', '/unknown'],
      ['127.0.0.1', 'http://[::1'],
      ['::1', 'http://[::1'],
    ] as const) {
      const sock = makeSocket();
      expect(() =>
        handleHqUpgrade({ url, headers: {} } as IncomingMessage, sock, Buffer.alloc(0), {
          ...baseDeps,
          host,
        } as never),
      ).not.toThrow();
      expect(sock.isDestroyed()).toBe(true);
    }
  });
});
