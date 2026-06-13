import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  announceWebuiReady,
  createWebuiShutdown,
  registerWebuiInstance,
  registerWebuiSignalHandlers,
  type WebUIInstanceRecord,
} from '../../src/webui-server/lifecycle.js';

/**
 * PR 7 of Issue #30 (webui-server 8-PR refactor): lifecycle unit tests.
 *
 * The three lifecycle concerns pulled out of runWebUI — instance
 * registration, the ready/open-browser banner, and SIGINT/SIGTERM
 * teardown — are driven here through their injectable seams, with no
 * disk IO, no browser launch, and no real process signal.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

describe('registerWebuiInstance', () => {
  it('builds the registry record (basename projectName + url) and passes baseDir', async () => {
    const calls: Array<{ record: WebUIInstanceRecord; baseDir?: string }> = [];
    registerWebuiInstance(
      {
        pid: 1234,
        host: '127.0.0.1',
        httpPort: 3456,
        wsPort: 3457,
        projectRoot: '/home/me/projects/acme',
        startedAt: '2026-06-13T00:00:00.000Z',
        registryBaseDir: '/cfg',
      },
      { registerFn: async (record, baseDir) => void calls.push({ record, baseDir }) },
    );
    // fire-and-forget — let the microtask run
    await Promise.resolve();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.baseDir).toBe('/cfg');
    expect(calls[0]?.record).toMatchObject({
      pid: 1234,
      httpPort: 3456,
      wsPort: 3457,
      host: '127.0.0.1',
      projectRoot: '/home/me/projects/acme',
      projectName: 'acme',
      startedAt: '2026-06-13T00:00:00.000Z',
      url: 'http://127.0.0.1:3456',
    });
  });

  it('swallows registry write failures (best-effort)', async () => {
    expect(() =>
      registerWebuiInstance(
        {
          pid: 1,
          host: '127.0.0.1',
          httpPort: 1,
          wsPort: 2,
          projectRoot: '/x',
          startedAt: 't',
          registryBaseDir: undefined,
        },
        { registerFn: async () => Promise.reject(new Error('disk full')) },
      ),
    ).not.toThrow();
    await Promise.resolve();
  });
});

describe('announceWebuiReady', () => {
  function fakeServer() {
    let listener: (() => void) | undefined;
    return {
      on: (_event: 'listening', cb: () => void) => {
        listener = cb;
      },
      fire: () => listener?.(),
    };
  }

  it('logs the banner and opens the browser when open=true', () => {
    const server = fakeServer();
    const logs: string[] = [];
    const opened: string[] = [];
    announceWebuiReady({
      server,
      host: '127.0.0.1',
      httpPort: 3456,
      wsPort: 3457,
      open: true,
      log: (m) => logs.push(m),
      openBrowserFn: (u) => opened.push(u),
    });
    // nothing happens until the server is listening
    expect(logs).toHaveLength(0);
    server.fire();
    expect(logs.join('\n')).toContain('WebUI ready');
    expect(opened).toEqual(['http://127.0.0.1:3456']);
  });

  it('does not open the browser when open=false', () => {
    const server = fakeServer();
    const opened: string[] = [];
    announceWebuiReady({
      server,
      host: '127.0.0.1',
      httpPort: 3456,
      wsPort: 3457,
      open: false,
      log: () => {},
      openBrowserFn: (u) => opened.push(u),
    });
    server.fire();
    expect(opened).toEqual([]);
  });
});

describe('createWebuiShutdown', () => {
  function makeRes(overrides: Partial<Parameters<typeof createWebuiShutdown>[0]> = {}) {
    const order: string[] = [];
    let wssCloseCb: (() => void) | undefined;
    const res = {
      abortInFlight: () => order.push('abort'),
      unsubscribeEvents: () => order.push('unsub'),
      closeClients: () => order.push('closeClients'),
      closeHttpServer: () => order.push('closeHttp'),
      wss: {
        close: (cb?: () => void) => {
          order.push('wssClose');
          wssCloseCb = cb;
        },
      },
      pid: 99,
      registryBaseDir: '/cfg',
      onStopped: () => order.push('stopped'),
      log: () => {},
      debug: () => {},
      unregisterFn: async (_pid: number, _baseDir?: string) => {
        order.push('unregister');
      },
      ...overrides,
    };
    return { res, order, fireWssClose: () => wssCloseCb?.() };
  }

  it('runs teardown in order and resolves only after unregister settles', async () => {
    const { res, order, fireWssClose } = makeRes();
    const shutdown = createWebuiShutdown(res);
    shutdown();
    // synchronous portion: abort → unsub → closeClients → (unregister kicks off) → closeHttp → wssClose
    expect(order).toEqual([
      'abort',
      'unsub',
      'closeClients',
      'unregister',
      'closeHttp',
      'wssClose',
    ]);
    // onStopped only after wss close callback + the unregister promise settles
    fireWssClose();
    await new Promise((r) => setTimeout(r, 0));
    expect(order.at(-1)).toBe('stopped');
  });

  it('is idempotent: a second call is a no-op', () => {
    const { res, order } = makeRes();
    const shutdown = createWebuiShutdown(res);
    shutdown();
    const afterFirst = order.length;
    shutdown();
    expect(order.length).toBe(afterFirst);
  });

  it('still resolves when unregister rejects', async () => {
    const { res, fireWssClose, order } = makeRes({
      unregisterFn: async () => Promise.reject(new Error('registry gone')),
    });
    const shutdown = createWebuiShutdown(res);
    shutdown();
    fireWssClose();
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toContain('stopped');
  });
});

describe('registerWebuiSignalHandlers', () => {
  it('registers on SIGINT/SIGTERM, fires shutdown once, and self-detaches', () => {
    const registered = new Map<string, () => void>();
    const onSpy = vi.spyOn(process, 'on').mockImplementation(((ev: string, cb: () => void) => {
      registered.set(ev, cb);
      return process;
    }) as typeof process.on);
    const offSpy = vi.spyOn(process, 'off').mockImplementation(((ev: string) => {
      registered.delete(ev);
      return process;
    }) as typeof process.off);

    let calls = 0;
    const unregister = registerWebuiSignalHandlers(() => {
      calls++;
    });

    expect(onSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));
    expect(onSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function));

    const handler = registered.get('SIGINT');
    expect(handler).toBeDefined();
    handler?.();
    expect(calls).toBe(1);
    // self-detached both listeners
    expect(offSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));
    expect(offSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function));

    // returned unregister is safe to call again
    expect(() => unregister()).not.toThrow();
  });
});
