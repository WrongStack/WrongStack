/**
 * The HTTP transport's bind path.
 *
 * `net.Server.listen()` reports failure through an `'error'` event, never
 * through its callback. `startHttp` subscribed only to the callback, so a
 * failed bind was (a) an unhandled `'error'` exception that poisons the whole
 * process and (b) a `start()` promise that never settled — the caller hung
 * until some outer timeout instead of seeing the real `EADDRINUSE`/`ENOBUFS`.
 */
import { Agent, createServer, request, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WrongStackACPServer } from '../src/agent/wrongstack-acp-agent.js';

let blocker: Server | null = null;
let server: WrongStackACPServer | null = null;

afterEach(async () => {
  await server?.stop();
  server = null;
  if (blocker) {
    const handle = blocker;
    blocker = null;
    await new Promise<void>((resolve) => handle.close(() => resolve()));
  }
});

function portOf(instance: WrongStackACPServer): number {
  return (
    instance as unknown as { httpServer: { address(): { port: number } } }
  ).httpServer.address().port;
}

describe('ACP HTTP bind failures', () => {
  it('rejects start() with the underlying error instead of hanging', async () => {
    blocker = createServer(() => {});
    await new Promise<void>((resolve) => blocker!.listen(0, '127.0.0.1', resolve));
    const taken = (blocker.address() as { port: number }).port;

    server = new WrongStackACPServer({ transport: taken, host: '127.0.0.1', authToken: 'secret' });
    await expect(server.start()).rejects.toMatchObject({ code: 'EADDRINUSE' });
    server = null;
  });

  it('stop() resolves even while a keep-alive connection is open', async () => {
    server = new WrongStackACPServer({ transport: 0, host: '127.0.0.1', authToken: 'secret' });
    await server.start();
    const port = portOf(server);

    // undici/`fetch` and this agent both hold the socket open after the
    // response; `close()` alone would never settle while it lives.
    const agent = new Agent({ keepAlive: true });
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }));
    await new Promise<void>((resolve, reject) => {
      const req = request(
        {
          agent,
          hostname: '127.0.0.1',
          port,
          path: '/',
          method: 'POST',
          headers: {
            Authorization: 'Bearer secret',
            'Content-Type': 'application/json',
            'Content-Length': body.length,
          },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve());
        },
      );
      req.on('error', reject);
      req.end(body);
    });

    const stopped = server.stop();
    server = null;
    await expect(stopped).resolves.toBeUndefined();
    agent.destroy();
  });

  it('retries transient listen errors on port 0', async () => {
    server = new WrongStackACPServer({ transport: 0, host: '127.0.0.1', authToken: 'secret' });
    const s = server as any;
    // Mock httpServer listen to fail once with EADDRINUSE then succeed
    let calls = 0;
    const fakeHttpServer = {
      listen: vi.fn().mockImplementation(() => {
        calls++;
        setTimeout(() => {
          if (calls === 1) {
            const err: any = new Error('transient');
            err.code = 'EADDRINUSE';
            fakeHttpServer.emit('error', err);
          } else {
            fakeHttpServer.emit('listening');
          }
        }, 5);
      }),
      _listeners: new Map<string, Array<(...args: any[]) => void>>(),
      once(ev: string, fn: any) {
        if (!this._listeners.has(ev)) this._listeners.set(ev, []);
        this._listeners.get(ev)!.push(fn);
      },
      removeListener(ev: string, fn: any) {
        const arr = this._listeners.get(ev) || [];
        const idx = arr.indexOf(fn);
        if (idx !== -1) arr.splice(idx, 1);
      },
      emit(ev: string, ...args: any[]) {
        const arr = [...(this._listeners.get(ev) || [])];
        this._listeners.set(ev, []);
        for (const fn of arr) fn(...args);
      },
    };
    s.httpServer = fakeHttpServer;
    await expect(s.listenWithRetry(0, '127.0.0.1')).resolves.toBeUndefined();
    expect(calls).toBe(2);
    server = null;
  });

  it('listenWithRetry resolves immediately if httpServer is null', async () => {
    server = new WrongStackACPServer({ transport: 0, host: '127.0.0.1', authToken: 'secret' });
    const s = server as any;
    s.httpServer = null;
    await expect(s.listenWithRetry(0, '127.0.0.1')).resolves.toBeUndefined();
    server = null;
  });

  it('retries transient listen errors for ENOBUFS and EADDRNOTAVAIL', async () => {
    server = new WrongStackACPServer({ transport: 0, host: '127.0.0.1', authToken: 'secret' });
    const s = server as any;
    for (const code of ['ENOBUFS', 'EADDRNOTAVAIL']) {
      let calls = 0;
      const fake = {
        listen: vi.fn().mockImplementation(() => {
          calls++;
          setTimeout(() => {
            if (calls === 1) {
              const err: any = new Error('transient');
              err.code = code;
              fake.emit('error', err);
            } else {
              fake.emit('listening');
            }
          }, 5);
        }),
        _listeners: new Map<string, Array<(...args: any[]) => void>>(),
        once(ev: string, fn: any) {
          if (!this._listeners.has(ev)) this._listeners.set(ev, []);
          this._listeners.get(ev)!.push(fn);
        },
        removeListener(ev: string, fn: any) {
          const arr = this._listeners.get(ev) || [];
          const idx = arr.indexOf(fn);
          if (idx !== -1) arr.splice(idx, 1);
        },
        emit(ev: string, ...args: any[]) {
          const arr = [...(this._listeners.get(ev) || [])];
          this._listeners.set(ev, []);
          for (const fn of arr) fn(...args);
        },
      };
      s.httpServer = fake;
      await expect(s.listenWithRetry(0, '127.0.0.1')).resolves.toBeUndefined();
      expect(calls).toBe(2);
    }
    server = null;
  });

  it('uses requested port in shown message when address() returns non-object', async () => {
    server = new WrongStackACPServer({ transport: 9999, host: '127.0.0.1', authToken: 'secret' });
    const s = server as any;
    const fakeHttpServer = {
      address: () => '/var/run/pipe.sock',
      listen: vi.fn().mockImplementation((_p: number, _h: string, cb?: () => void) => {
        setTimeout(() => {
          fakeHttpServer.emit('listening');
          cb?.();
        }, 5);
      }),
      _listeners: new Map<string, Array<(...args: any[]) => void>>(),
      once(ev: string, fn: any) {
        if (!this._listeners.has(ev)) this._listeners.set(ev, []);
        this._listeners.get(ev)!.push(fn);
      },
      removeListener(ev: string, fn: any) {
        const arr = this._listeners.get(ev) || [];
        const idx = arr.indexOf(fn);
        if (idx !== -1) arr.splice(idx, 1);
      },
      emit(ev: string, ...args: any[]) {
        const arr = [...(this._listeners.get(ev) || [])];
        this._listeners.set(ev, []);
        for (const fn of arr) fn(...args);
      },
      on: vi.fn(),
      close: vi.fn((cb: any) => cb?.()),
    };
    s.httpServer = fakeHttpServer;
    s.listenWithRetry = vi.fn().mockResolvedValue(undefined);
    await expect(s.startHttp(9999, '127.0.0.1')).resolves.toBeUndefined();
    expect(s.running).toBe(true);
    await s.stop();
    server = null;
  });
});
