import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { createServer } = vi.hoisted(() => ({
  createServer: vi.fn(),
}));

vi.mock('node:http', () => ({ createServer }));

import { setupCompanionServer } from '../src/server/start-webui-companion.js';

class FakeServer extends EventEmitter {
  readonly listen = vi.fn((_port: number, _host: string, callback: () => void) => callback());
}

describe('setupCompanionServer', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null when the primary host has no companion mapping', () => {
    expect(setupCompanionServer(new FakeServer() as never, '192.0.2.10', 3456)).toBeNull();
    expect(createServer).not.toHaveBeenCalled();
  });

  it('binds the IPv6 companion and forwards HTTP and WebSocket events', () => {
    const primary = new FakeServer();
    const companion = new FakeServer();
    createServer.mockReturnValue(companion);
    const primaryEmit = vi.spyOn(primary, 'emit');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const result = setupCompanionServer(primary as never, '127.0.0.1', 3456);
    const request = {};
    const response = {};
    const socket = {};
    const head = Buffer.from('head');
    companion.emit('request', request, response);
    companion.emit('upgrade', request, socket, head);

    expect(result).toBe(companion);
    expect(companion.listen).toHaveBeenCalledWith(3456, '::1', expect.any(Function));
    expect(primaryEmit).toHaveBeenCalledWith('request', request, response);
    expect(primaryEmit).toHaveBeenCalledWith('upgrade', request, socket, head);
    expect(console.log).toHaveBeenCalledWith(
      '[WebUI] HTTP server running on http://[::1]:3456',
    );
  });

  it('warns for unexpected companion listener errors without throwing', () => {
    const companion = new FakeServer();
    createServer.mockReturnValue(companion);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    setupCompanionServer(new FakeServer() as never, '::', 3456);
    companion.emit('error', Object.assign(new Error('boom'), { code: 'EPERM' }));

    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('companion listener on 0.0.0.0 failed (EPERM): boom'),
    );
  });
});
