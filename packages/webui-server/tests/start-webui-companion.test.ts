import { EventEmitter } from 'node:events';
import * as net from 'node:net';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const { createServer } = vi.hoisted(() => ({
  createServer: vi.fn(),
}));

vi.mock('node:http', () => ({ createServer }));

import { setupCompanionServer } from '../src/server/start-webui-companion.js';

/**
 * Minimal fake http.Server for the companion bind. `listenWithRetry`
 * resolves on the 'listening' event (not the listen callback) and reads
 * `server.address()` for the bound port, so the fake mirrors that contract.
 */
class FakeServer extends EventEmitter {
  /** When set, the next listen() emits this error instead of 'listening'. */
  listenError: NodeJS.ErrnoException | null = null;
  readonly listen = vi.fn((_port: number, _host: string, callback?: () => void) => {
    setImmediate(() => {
      if (this.listenError) {
        this.emit('error', this.listenError);
        return;
      }
      this.emit('listening');
      callback?.();
    });
    return this;
  });
  address(): { port: number; family: string; address: string } | null {
    return null;
  }
}

/**
 * Bind port 0 on `host`, read the OS-assigned port, then release it — a
 * reserve-and-release cycle that yields a port the OS just confirmed free
 * on that exact address.
 *
 * The suite cannot hard-code 3456: `listenWithRetry` probes the COMPANION
 * address with a REAL throwaway socket before calling the mocked `listen`,
 * and the companion never advances ports (maxTries: 1 — it must mirror the
 * primary's port). So when a live WebUI holds 3456 on the companion
 * address, the probe sees EADDRINUSE, the bind rejects, and the companion
 * degrades to null — the bind-success tests then fail. Each companion
 * address under test (::1 and 0.0.0.0) gets its own verified-free port.
 */
async function reserveFreePort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, host, () => {
      const address = srv.address();
      const port = address && typeof address === 'object' ? address.port : null;
      srv.close(() => {
        if (port === null) reject(new Error('no port assigned by listen(0)'));
        else resolve(port);
      });
    });
  });
}

describe('setupCompanionServer', () => {
  // Verified-free per companion address (see reserveFreePort): v6 backs the
  // ::1 companion (primary 127.0.0.1), v4 the 0.0.0.0 companion (primary ::).
  const ports = { v6: 0, v4: 0 };

  beforeAll(async () => {
    ports.v6 = await reserveFreePort('::1');
    ports.v4 = await reserveFreePort('0.0.0.0');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('returns null when the primary host has no companion mapping', async () => {
    await expect(
      setupCompanionServer(new FakeServer() as never, '192.0.2.10', ports.v6),
    ).resolves.toBeNull();
    expect(createServer).not.toHaveBeenCalled();
  });

  it('binds the IPv6 companion and forwards HTTP and WebSocket events', async () => {
    const primary = new FakeServer();
    const companion = new FakeServer();
    createServer.mockReturnValue(companion);
    const primaryEmit = vi.spyOn(primary, 'emit');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const result = await setupCompanionServer(primary as never, '127.0.0.1', ports.v6);
    const request = {};
    const response = {};
    const socket = {};
    const head = Buffer.from('head');
    companion.emit('request', request, response);
    companion.emit('upgrade', request, socket, head);

    expect(result).toBe(companion);
    // listenWithRetry calls listen(port, host) — no callback argument.
    expect(companion.listen).toHaveBeenCalledWith(ports.v6, '::1');
    expect(primaryEmit).toHaveBeenCalledWith('request', request, response);
    expect(primaryEmit).toHaveBeenCalledWith('upgrade', request, socket, head);
    expect(console.log).toHaveBeenCalledWith(
      `[WebUI] HTTP server running on http://[::1]:${ports.v6}`,
    );
  });

  it('downgrades to null (never advancing ports) when the mirror bind hits EADDRINUSE', async () => {
    const companion = new FakeServer();
    companion.listenError = Object.assign(new Error('bind EADDRINUSE'), {
      code: 'EADDRINUSE',
    });
    createServer.mockReturnValue(companion);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await setupCompanionServer(new FakeServer() as never, '127.0.0.1', ports.v6);

    expect(result).toBeNull();
    // Never advances: every re-bind targets the primary's port. A bind that
    // reports EADDRINUSE on a port the probe just called free is re-tried in
    // place (the phantom-EADDRINUSE window), so the attempt count is bounded
    // rather than one — but the port the companion asks for never moves.
    expect(companion.listen.mock.calls.map((call) => call[0])).toEqual(
      Array.from({ length: companion.listen.mock.calls.length }, () => ports.v6),
    );
    expect(companion.listen.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not started (EADDRINUSE)'));
  });

  it('warns for unexpected companion bind errors without throwing', async () => {
    const companion = new FakeServer();
    companion.listenError = Object.assign(new Error('boom'), { code: 'EPERM' });
    createServer.mockReturnValue(companion);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await setupCompanionServer(new FakeServer() as never, '::', ports.v4);

    expect(result).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('companion listener on 0.0.0.0 not started (EPERM): boom'),
    );
  });

  it('logs late companion runtime errors without throwing', async () => {
    const companion = new FakeServer();
    createServer.mockReturnValue(companion);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await setupCompanionServer(new FakeServer() as never, '::', ports.v4);
    companion.emit('error', Object.assign(new Error('boom'), { code: 'EPERM' }));

    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('companion listener on 0.0.0.0 failed (EPERM): boom'),
    );
  });
});
