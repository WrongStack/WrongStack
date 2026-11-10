/**
 * A callback listener on port 0 asks the OS for any free port, so a failed
 * bind there is transient (seen under load on Windows), not "the port is
 * taken": the sign-in must not fall back to manual code entry on the first
 * failure. The spy sits on http.Server: under Bun it does not inherit
 * listen from net.Server.
 */
import { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startLoopbackServer } from '../../src/oauth/shared.js';

const realListen = Server.prototype.listen;

/** Make the next `failures` binds to port 0 emit an error instead of listening. */
function failEphemeralBinds(failures: number) {
  let left = failures;
  return vi.spyOn(Server.prototype, 'listen').mockImplementation(function (
    this: Server,
    ...args: unknown[]
  ) {
    if (args[0] === 0 && left > 0) {
      left -= 1;
      process.nextTick(() =>
        this.emit('error', Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' })),
      );
      return this;
    }
    return (realListen as (...a: unknown[]) => Server).apply(this, args);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

const options = { port: 0, host: '127.0.0.1', path: '/callback', expectedState: 's' };

describe('loopback callback listener on an ephemeral port', () => {
  it('binds after a transient failure instead of giving up', async () => {
    const listen = failEphemeralBinds(1);
    const server = await startLoopbackServer(options);
    try {
      expect(server.bound).toBe(true);
      expect(server.port).toBeGreaterThan(0);
      expect(listen).toHaveBeenCalledTimes(2);
    } finally {
      server.close();
    }
  });

  it('still reports unbound when every attempt fails', async () => {
    failEphemeralBinds(Number.POSITIVE_INFINITY);
    const server = await startLoopbackServer(options);
    expect(server.bound).toBe(false);
    server.close();
  });
});
