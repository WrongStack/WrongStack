import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { startDeferredHttpListen } from '../../src/webui-server/listen-helpers.js';

const logger = {
  warn: vi.fn(),
  error: vi.fn(),
};

/**
 * Fake http.Server whose bind fails on one poisoned port with a configurable
 * errno and succeeds anywhere else — the TOCTOU shape `listenWithRetry`
 * exists for. Mirrors the real contract: 'listening' emitted asynchronously
 * (not via the listen callback) and `address()` reporting the bound port.
 *
 * The whole port is poisoned rather than just the first attempt: a bind that
 * reports EADDRINUSE on a port the pre-bind probe just called free is first
 * re-tried in place (the phantom-EADDRINUSE window Bun on Windows opens),
 * and only a port that keeps refusing makes the ladder advance.
 */
class FlakyBindServer extends EventEmitter {
  attempts: Array<[number, string]> = [];
  /** Every bind of this port emits `bindError` instead of 'listening'. */
  poisonedPort: number | null = null;
  bindError: NodeJS.ErrnoException | null = null;
  boundPort = 0;
  listen(port: number, host: string): this {
    this.attempts.push([port, host]);
    setImmediate(() => {
      if (this.bindError !== null && port === this.poisonedPort) {
        // Real emit semantics on purpose: a listener that throws aborts the
        // emit loop, so listeners appended after it never run. The try/catch
        // only stands in for the runtime that would otherwise turn that
        // throw into an uncaughtException — it does not rescue the loop.
        try {
          this.emit('error', this.bindError);
        } catch {
          /* swallowed by the host runtime, exactly as in production */
        }
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
    server.poisonedPort = 48_600;
    server.bindError = Object.assign(new Error('bind EADDRINUSE'), {
      code: 'EADDRINUSE',
    });

    const boundPort = await startDeferredHttpListen({
      server: server as never,
      host: '127.0.0.1',
      httpPort: 48_600,
      logger,
    });

    // In-place re-tries first, then exactly one advance to +1.
    const ports = server.attempts.map(([port]) => port);
    expect(ports.at(-1)).toBe(48_601);
    expect(new Set(ports.slice(0, -1))).toEqual(new Set([48_600]));
    expect(server.attempts.every(([, host]) => host === '127.0.0.1')).toBe(true);
    expect(boundPort).toBe(48_601);
  });

  it('fail-fast in strict mode: EADDRINUSE rejects after a single attempt', async () => {
    const server = new FlakyBindServer();
    server.poisonedPort = 48_600;
    server.bindError = Object.assign(new Error('bind EADDRINUSE'), {
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

    // Strict forbids ADVANCING, not re-trying: bounded in-place re-binds are
    // still allowed (a phantom EADDRINUSE must not fail a strict start), but
    // the requested port is the only one ever attempted.
    expect(new Set(server.attempts.map(([port]) => port))).toEqual(new Set([48_600]));
  });

  it('settles even when a co-listener throws from the server error emit', async () => {
    // `ws` forwards an HTTP server's 'error' onto a WebSocketServer that may
    // have no 'error' listener during the bind window; that re-emit throws
    // and aborts the emit loop. The bind must still settle — an appended
    // handler would never run and startup would hang forever.
    const server = new FlakyBindServer();
    server.poisonedPort = 48_700;
    server.bindError = Object.assign(new Error('bind EADDRINUSE'), {
      code: 'EADDRINUSE',
    });
    server.on('error', () => {
      throw new Error('co-listener explodes (ws error forwarder)');
    });

    const boundPort = await startDeferredHttpListen({
      server: server as never,
      host: '127.0.0.1',
      httpPort: 48_700,
      logger,
    });

    expect(boundPort).toBe(48_701);
  });
});
