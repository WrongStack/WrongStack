import type { Server } from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreateHttpServerOptions } from '../src/server/http-server.js';

const createHttpServer = vi.hoisted(() =>
  vi.fn((_opts: CreateHttpServerOptions) => ({}) as unknown as Server),
);

vi.mock('../src/server/http-server.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/server/http-server.js')>()),
  createHttpServer,
}));

/**
 * Regression guard for host option drift.
 *
 * `createHttpServer` hands its whole options object to `handleApiRoutes`, so a
 * field one host forgot to copy silently disabled a feature on that host only
 * (watcherMetrics, allowedHostnames, indexDir, executePackageOperation — each
 * fixed separately). Both hosts now build the options through
 * `resolveCreateHttpServerOptions`; this pins that they hand `createHttpServer`
 * the exact same key set, even when called with minimal input.
 */
describe('startStaticServe / startHttpServer → createHttpServer key parity', () => {
  beforeEach(() => {
    createHttpServer.mockClear();
  });

  const fromStaticServe = async (
    extra: { publicWsUrl?: string } = {},
  ): Promise<CreateHttpServerOptions> => {
    const { startStaticServe } = await import('../src/server/frontend-static-serve.js');
    const createServer = vi.fn((_opts: CreateHttpServerOptions) => ({}) as unknown as Server);
    await startStaticServe(
      {
        host: '127.0.0.1',
        httpPort: 3456,
        globalRoot: '/tmp/.wrongstack',
        deferListen: true,
        ...extra,
      },
      { createServer, resolveDist: () => '/tmp/dist' },
    );
    expect(createServer).toHaveBeenCalledTimes(1);
    return createServer.mock.calls[0]![0];
  };

  const fromHttpServer = async (
    extra: { publicWsUrl?: string } = {},
  ): Promise<CreateHttpServerOptions> => {
    createHttpServer.mockClear();
    const { startHttpServer } = await import('../src/server/server-runtime.js');
    startHttpServer({
      wsHost: '127.0.0.1',
      httpPort: 3456,
      wsToken: 'token',
      publicWsUrl: undefined,
      publicUrl: undefined,
      requireToken: false,
      globalRoot: '/tmp/.wrongstack',
      globalConfigPath: '/tmp/.wrongstack/config.json',
      projectRoot: '/tmp/project',
      ...extra,
    } as Parameters<typeof startHttpServer>[0]);
    expect(createHttpServer).toHaveBeenCalledTimes(1);
    return createHttpServer.mock.calls[0]![0];
  };

  it('passes an identical Object.keys set from both hosts', async () => {
    const fromStatic = Object.keys(await fromStaticServe()).sort();
    const fromRuntime = Object.keys(await fromHttpServer()).sort();

    expect(fromStatic).toEqual(fromRuntime);
    // The fields that were previously dropped on one path or the other.
    for (const key of [
      'watcherMetrics',
      'allowedHostnames',
      'indexDir',
      'executePackageOperation',
      'secureCookies',
      'enableWsCookie',
      'getMemoryStore',
    ]) {
      expect(fromStatic).toContain(key);
    }
  });

  it('settles the cookie policy identically on both hosts', async () => {
    for (const publicWsUrl of [undefined, 'wss://tunnel.example.com/ws']) {
      const extra = publicWsUrl ? { publicWsUrl } : {};
      const fromStatic = await fromStaticServe(extra);
      const fromRuntime = await fromHttpServer(extra);
      const expected = { enableWsCookie: true, secureCookies: publicWsUrl !== undefined };
      expect({
        enableWsCookie: fromStatic.enableWsCookie,
        secureCookies: fromStatic.secureCookies,
      }).toEqual(expected);
      expect({
        enableWsCookie: fromRuntime.enableWsCookie,
        secureCookies: fromRuntime.secureCookies,
      }).toEqual(expected);
    }
  });
});
