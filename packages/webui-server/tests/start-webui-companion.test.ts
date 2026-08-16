import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

describe('setupCompanionServer', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('returns null when the primary host has no companion mapping', async () => {
    await expect(
      setupCompanionServer(new FakeServer() as never, '192.0.2.10', 3456),
    ).resolves.toBeNull();
    expect(createServer).not.toHaveBeenCalled();
  });

  it('binds the IPv6 companion and forwards HTTP and WebSocket events', async () => {
    const primary = new FakeServer();
    const companion = new FakeServer();
    createServer.mockReturnValue(companion);
    const primaryEmit = vi.spyOn(primary, 'emit');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const result = await setupCompanionServer(primary as never, '127.0.0.1', 3456);
    const request = {};
    const response = {};
    const socket = {};
    const head = Buffer.from('head');
    companion.emit('request', request, response);
    companion.emit('upgrade', request, socket, head);

    expect(result).toBe(companion);
    // listenWithRetry calls listen(port, host) — no callback argument.
    expect(companion.listen).toHaveBeenCalledWith(3456, '::1');
    expect(primaryEmit).toHaveBeenCalledWith('request', request, response);
    expect(primaryEmit).toHaveBeenCalledWith('upgrade', request, socket, head);
    expect(console.log).toHaveBeenCalledWith('[WebUI] HTTP server running on http://[::1]:3456');
  });

  it('downgrades to null (never advancing ports) when the mirror bind hits EADDRINUSE', async () => {
    const companion = new FakeServer();
    companion.listenError = Object.assign(new Error('bind EADDRINUSE'), {
      code: 'EADDRINUSE',
    });
    createServer.mockReturnValue(companion);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await setupCompanionServer(new FakeServer() as never, '127.0.0.1', 3456);

    expect(result).toBeNull();
    // Exactly one bind attempt — the companion must mirror the primary's port.
    expect(companion.listen).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not started (EADDRINUSE)'));
  });

  it('warns for unexpected companion bind errors without throwing', async () => {
    const companion = new FakeServer();
    companion.listenError = Object.assign(new Error('boom'), { code: 'EPERM' });
    createServer.mockReturnValue(companion);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await setupCompanionServer(new FakeServer() as never, '::', 3456);

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

    await setupCompanionServer(new FakeServer() as never, '::', 3456);
    companion.emit('error', Object.assign(new Error('boom'), { code: 'EPERM' }));

    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('companion listener on 0.0.0.0 failed (EPERM): boom'),
    );
  });
});
