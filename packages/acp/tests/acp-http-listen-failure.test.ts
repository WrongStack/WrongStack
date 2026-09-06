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
import { afterEach, describe, expect, it } from 'vitest';
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
});
