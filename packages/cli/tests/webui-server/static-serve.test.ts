import { EventEmitter } from 'node:events';
import type { Server } from 'node:http';
import * as net from 'node:net';
import * as path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  resolveDistDir,
  type StaticServeHandle,
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
  /** When set, address() reports this bound port (e.g. after a retry advance). */
  boundPort: number | null = null;
  listen(port: number, host: string): this {
    this.listenCalls.push([port, host]);
    // listenWithRetry resolves on the server's 'listening' event, not the
    // listen() callback — emit it asynchronously like a real socket bind.
    setImmediate(() => this.emit('listening'));
    return this;
  }
  // listenWithRetry's onListening reads server.address() for the bound
  // port; null makes it fall back to the candidate (requested) port.
  address(): { port: number; family: string; address: string } | null {
    return this.boundPort === null
      ? null
      : { port: this.boundPort, family: 'IPv4', address: '127.0.0.1' };
  }
  close(): this {
    this.closed = true;
    return this;
  }
}

/** The createServer mocks are declared parameterless; read their args untyped. */
function firstServerOptions(mock: { mock: { calls: unknown[] } }): Record<string, unknown> {
  const call = mock.mock.calls[0] as unknown[] | undefined;
  return (call?.[0] ?? {}) as Record<string, unknown>;
}

describe('resolveDistDir', () => {
  it('uses an explicit frontend directory without resolving the webui package', () => {
    expect(resolveDistDir('./custom-simpleui')).toBe(path.resolve('./custom-simpleui'));
  });

  it('resolves the webui dist directory in the monorepo', () => {
    const dir = resolveDistDir();
    // The webui package is a workspace dep of the cli, so the
    // server entry resolves and the parent dir is `.../dist`.
    // When webui has not been built yet, this returns null — skip the
    // assertion rather than failing so CI environments without a built
    // webui still get a clean run.
    if (dir === null) return;
    expect(dir?.replace(/\\/g, '/')).toMatch(/\/dist$/);
  });
});

/**
 * Bind port 0 on `host`, read the OS-assigned port, then release it — a
 * reserve-and-release cycle that yields a port the OS just confirmed free.
 *
 * The suite cannot hard-code 3456: `listenWithRetry` probes the port with a
 * REAL throwaway socket before calling the mocked `listen`, so when a live
 * WebUI (or any other listener) holds the default port on a dev machine, the
 * probe sees EADDRINUSE and advances one port up — the fake's `listenCalls`
 * then disagree with the hard-coded assertion. A verified-free ephemeral
 * port keeps the real probe in the tested path (which is the point of these
 * wiring tests) while removing the dependency on machine state.
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

describe('startStaticServe', () => {
  const baseOpts = {
    host: '127.0.0.1',
    // Replaced in beforeAll with a verified-free port; every port assertion
    // in this suite reads it dynamically.
    httpPort: 0,
    globalRoot: '/tmp/.wrongstack',
  };

  beforeAll(async () => {
    baseOpts.httpPort = await reserveFreePort(baseOpts.host);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null when dist cannot be resolved (webui unbuilt)', async () => {
    const createServer = vi.fn();
    const handle = await startStaticServe(baseOpts, {
      resolveDist: () => null,
      createServer,
    });
    expect(handle).toBeNull();
    // It must short-circuit before ever creating a server.
    expect(createServer).not.toHaveBeenCalled();
  });

  it('threads options into createHttpServer and listens on httpPort/host', async () => {
    const fake = new FakeServer();
    const createServer = vi.fn(() => fake as never as Server);

    const handle = (await startStaticServe(baseOpts, {
      resolveDist: () => '/resolved/dist',
      createServer,
    })) as StaticServeHandle;

    expect(handle).not.toBeNull();
    expect(createServer).toHaveBeenCalledTimes(1);
    expect(createServer).toHaveBeenCalledWith(
      expect.objectContaining({
        host: '127.0.0.1',
        port: baseOpts.httpPort,
        distDir: '/resolved/dist',
        globalRoot: '/tmp/.wrongstack',
      }),
    );
    // Binds the *http* port, not the ws port.
    expect(fake.listenCalls).toEqual([[baseOpts.httpPort, '127.0.0.1']]);
    // Returns the requested http port (see function doc).
    expect(handle.port).toBe(baseOpts.httpPort);
    expect(handle.server).toBe(fake);
  });

  it('propagates the actually-bound port when the bind advances past a busy port', async () => {
    const fake = new FakeServer();
    // Simulate the TOCTOU race the safety net exists for: the requested
    // port was probed free, a competitor takes it in the window, and the
    // OS really binds one port higher.
    fake.boundPort = baseOpts.httpPort + 1;
    const createServer = vi.fn(() => fake as never as Server);

    const handle = (await startStaticServe(baseOpts, {
      resolveDist: () => '/resolved/dist',
      createServer,
    })) as StaticServeHandle;

    expect(handle).not.toBeNull();
    // The requested port was attempted on the right host…
    expect(fake.listenCalls).toEqual([[baseOpts.httpPort, '127.0.0.1']]);
    // …but the handle must expose the port the socket actually bound —
    // access URLs, the instance registry, and the ready banner all
    // consume handle.port downstream.
    expect(handle.port).toBe(baseOpts.httpPort + 1);
  });

  it('threads an explicit frontend directory through the resolver', async () => {
    const fake = new FakeServer();
    const resolveDist = vi.fn(() => '/resolved/simpleui-dist');
    const createServer = vi.fn(() => fake as never as Server);

    await startStaticServe(
      { ...baseOpts, distDir: '/packages/simpleui/dist' },
      { resolveDist, createServer },
    );

    expect(resolveDist).toHaveBeenCalledWith('/packages/simpleui/dist');
    expect(createServer).toHaveBeenCalledWith(
      expect.objectContaining({ distDir: '/resolved/simpleui-dist' }),
    );
  });

  it('passes apiToken to createHttpServer when provided', async () => {
    const fake = new FakeServer();
    const createServer = vi.fn(() => fake as never as Server);

    const handle = (await startStaticServe(
      { ...baseOpts, apiToken: 'test-token-123' },
      {
        resolveDist: () => '/resolved/dist',
        createServer,
      },
    )) as StaticServeHandle;

    expect(handle).not.toBeNull();
    expect(createServer).toHaveBeenCalledWith(
      expect.objectContaining({
        host: '127.0.0.1',
        port: baseOpts.httpPort,
        distDir: '/resolved/dist',
        globalRoot: '/tmp/.wrongstack',
        apiToken: 'test-token-123',
      }),
    );
  });

  it('passes public WS URL and requireToken to createHttpServer when provided', async () => {
    const fake = new FakeServer();
    const createServer = vi.fn(() => fake as never as Server);

    const handle = (await startStaticServe(
      {
        ...baseOpts,
        publicWsUrl: 'wss://wrongstack-ws.example.com',
        requireToken: true,
      },
      {
        resolveDist: () => '/resolved/dist',
        createServer,
      },
    )) as StaticServeHandle;

    expect(handle).not.toBeNull();
    expect(createServer).toHaveBeenCalledWith(
      expect.objectContaining({
        host: '127.0.0.1',
        port: baseOpts.httpPort,
        distDir: '/resolved/dist',
        globalRoot: '/tmp/.wrongstack',
        publicWsUrl: 'wss://wrongstack-ws.example.com',
        requireToken: true,
      }),
    );
  });

  it('builds a per-project intake service so the hosted WebUI does not 503', async () => {
    const fake = new FakeServer();
    const createServer = vi.fn(() => fake as never as Server);

    await startStaticServe(
      { ...baseOpts, projectRoot: '/repo/app' },
      { resolveDist: () => '/resolved/dist', createServer },
    );

    const passed = firstServerOptions(createServer);
    expect(passed['intakeService']).toBeDefined();
  });

  it('leaves the intake service unset when there is no project to scope it to', async () => {
    const fake = new FakeServer();
    const createServer = vi.fn(() => fake as never as Server);

    await startStaticServe(baseOpts, { resolveDist: () => '/resolved/dist', createServer });

    const passed = firstServerOptions(createServer);
    expect(passed['intakeService']).toBeUndefined();
  });

  it('does not swallow a real createServer failure', async () => {
    const boom = new Error('createHttpServer exploded');
    await expect(
      startStaticServe(baseOpts, {
        resolveDist: () => '/resolved/dist',
        createServer: () => {
          throw boom;
        },
      }),
    ).rejects.toThrow(boom);
  });
});
