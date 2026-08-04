import type { Server } from 'node:http';
import { EventEmitter } from 'node:events';
import * as path from 'node:path';
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

describe('startStaticServe', () => {
  const baseOpts = {
    host: '127.0.0.1',
    httpPort: 3456,
    globalRoot: '/tmp/.wrongstack',
  };

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
        port: 3456,
        distDir: '/resolved/dist',
        globalRoot: '/tmp/.wrongstack',
      }),
    );
    // Binds the *http* port, not the ws port.
    expect(fake.listenCalls).toEqual([[3456, '127.0.0.1']]);
    // Returns the requested http port (see function doc).
    expect(handle.port).toBe(3456);
    expect(handle.server).toBe(fake);
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
        port: 3456,
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
        port: 3456,
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
