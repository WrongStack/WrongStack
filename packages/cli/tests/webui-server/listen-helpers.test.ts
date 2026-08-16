import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { startDeferredHttpListen } from '../../src/webui-server/listen-helpers.js';

const logger = {
  warn: vi.fn(),
  error: vi.fn(),
};

/**
 * Fake http.Server whose bind fails the first time with a configurable
 * errno, then succeeds — the TOCTOU shape `listenWithRetry` exists for.
 * Mirrors the real contract: 'listening' emitted asynchronously (not via
 * the listen callback) and `address()` reporting the bound port.
 */
class FlakyBindServer extends EventEmitter {
  attempts: Array<[number, string]> = [];
  /** When set, the first listen() attempt emits this error instead of 'listening'. */
  firstBindError: NodeJS.ErrnoException | null = null;
  boundPort = 0;
  listen(port: number, host: string): this {
    this.attempts.push([port, host]);
    setImmediate(() => {
      if (this.firstBindError !== null && this.attempts.length === 1) {
        const err = this.firstBindError;
        this.firstBindError = null;
        this.emit('error', err);
        return;
      }
      this.boundPort = port;
      this.emit('listening');
    });
    return this;
  }
  address(): { port: number; family: string; address: string } | null {
    return { port: this.boundPort, family: 'IPv4', address: '127.0.0.1' };
  }
}

describe('startDeferredHttpListen', () => {
  it('returns the advanced port when the bind retries past an EADDRINUSE', async () => {
    const server = new FlakyBindServer();
    server.firstBindError = Object.assign(new Error('bind EADDRINUSE'), {
      code: 'EADDRINUSE',
    });

    const boundPort = await startDeferredHttpListen({
      server: server as never,
      host: '127.0.0.1',
      httpPort: 48_600,
      logger,
    });

    // Exactly the two-attempt advance: requested port, then +1.
    expect(server.attempts).toEqual([
      [48_600, '127.0.0.1'],
      [48_601, '127.0.0.1'],
    ]);
    expect(boundPort).toBe(48_601);
  });

  it('fail-fast in strict mode: EADDRINUSE rejects after a single attempt', async () => {
    const server = new FlakyBindServer();
    server.firstBindError = Object.assign(new Error('bind EADDRINUSE'), {
      code: 'EADDRINUSE',
    });

    await expect(
      startDeferredHttpListen({
        server: server as never,
        host: '127.0.0.1',
        httpPort: 48_600,
        logger,
        strictPort: true,
      }),
    ).rejects.toMatchObject({ code: 'EADDRINUSE' });

    // Strict means exactly one bind attempt — no advance.
    expect(server.attempts).toEqual([[48_600, '127.0.0.1']]);
  });
});
