import type { Server } from 'node:http';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type StaticServeHandle,
  resolveDistDir,
  startStaticServe,
} from '../../src/webui-server/static-serve.js';

/**
 * PR 6 of Issue #30 (webui-server 8-PR refactor):
 * static-serve unit tests.
 *
 * `startStaticServe` resolves the webui `dist` dir and
 * brings up the HTTP server, or returns null when the
 * webui package isn't built. The two seams it touches —
 * module resolution (`resolveDist`) and server creation
 * (`createServer`) — are injectable, so these tests assert
 * the wiring and the degrade-to-null path without resolving
 * the real package or binding a real socket.
 */

/** Minimal fake http.Server: records listen() args, supports close(). */
class FakeServer extends EventEmitter {
  listenCalls: Array<[number, string]> = [];
  closed = false;
  listen(port: number, host: string): this {
    this.listenCalls.push([port, host]);
    return this;
  }
  close(): this {
    this.closed = true;
    return this;
  }
}

describe('resolveDistDir', () => {
  it('resolves the webui dist directory in the monorepo', () => {
    const dir = resolveDistDir();
    // The webui package is a workspace dep of the cli, so the
    // server entry resolves and the parent dir is `.../dist`.
    expect(dir).not.toBeNull();
    expect(dir?.replace(/\\/g, '/')).toMatch(/\/dist$/);
  });
});

describe('startStaticServe', () => {
  const baseOpts = {
    host: '127.0.0.1',
    httpPort: 3456,
    wsPort: 3457,
    globalRoot: '/tmp/.wrongstack',
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null when dist cannot be resolved (webui unbuilt)', () => {
    const createServer = vi.fn();
    const handle = startStaticServe(baseOpts, {
      resolveDist: () => null,
      createServer,
    });
    expect(handle).toBeNull();
    // It must short-circuit before ever creating a server.
    expect(createServer).not.toHaveBeenCalled();
  });

  it('threads options into createHttpServer and listens on httpPort/host', () => {
    const fake = new FakeServer();
    const createServer = vi.fn(() => fake as unknown as Server);

    const handle = startStaticServe(baseOpts, {
      resolveDist: () => '/resolved/dist',
      createServer,
    }) as StaticServeHandle;

    expect(handle).not.toBeNull();
    expect(createServer).toHaveBeenCalledTimes(1);
    expect(createServer).toHaveBeenCalledWith({
      host: '127.0.0.1',
      distDir: '/resolved/dist',
      wsPort: 3457,
      globalRoot: '/tmp/.wrongstack',
    });
    // Binds the *http* port, not the ws port.
    expect(fake.listenCalls).toEqual([[3456, '127.0.0.1']]);
    // Returns the requested http port (see function doc).
    expect(handle.port).toBe(3456);
    expect(handle.server).toBe(fake);
  });

  it('does not swallow a real createServer failure', () => {
    const boom = new Error('createHttpServer exploded');
    expect(() =>
      startStaticServe(baseOpts, {
        resolveDist: () => '/resolved/dist',
        createServer: () => {
          throw boom;
        },
      }),
    ).toThrow(boom);
  });
});
