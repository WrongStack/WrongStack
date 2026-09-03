import { describe, it, expect, afterEach } from 'vitest';

// We'll test with a real net.Server since mocking it is fragile
// The module is simple enough that real port-binding tests are more reliable

import { isPortFree, findFreePort, listenWithRetry } from '../src/server/port-utils.js';

describe('port-utils', () => {
  // Use a high port range to avoid conflicts
  const BASE_PORT = 23456;

  describe('isPortFree', () => {
    it('resolves to true when the port is free', async () => {
      // Ports in the 20000+ range are usually free in CI
      const result = await isPortFree('127.0.0.1', BASE_PORT);
      expect(result).toBe(true);
    });

    it('resolves to false when the port is occupied', async () => {
      // Bind a server to occupy a port
      const net = await import('node:net');
      const server = net.createServer();
      await new Promise<void>((resolve, reject) => {
        server.listen(BASE_PORT + 1, '127.0.0.1', (err?: Error) => {
          if (err) reject(err);
          else resolve();
        });
      });

      try {
        const result = await isPortFree('127.0.0.1', BASE_PORT + 1);
        expect(result).toBe(false);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });

  describe('findFreePort', () => {
    it('returns a free port at or above startPort', async () => {
      const port = await findFreePort('127.0.0.1', BASE_PORT + 10);
      expect(port).toBeGreaterThanOrEqual(BASE_PORT + 10);
      expect(port).toBeLessThanOrEqual(65535);
    });

    it('skips excluded ports', async () => {
      const exclude = new Set([BASE_PORT + 20]);
      const port = await findFreePort('127.0.0.1', BASE_PORT + 20, { exclude });
      // Should skip BASE_PORT + 20 and return the next one
      expect(port).toBe(BASE_PORT + 21);
      expect(exclude.has(port)).toBe(false);
    });

    it('wraps port beyond 65535 into the ephemeral range', async () => {
      // startPort > 65535 should wrap
      const port = await findFreePort('127.0.0.1', 65536, { maxTries: 1 });
      // 1024 + (65536 % 50000) = 1024 + 15536 = 16560
      expect(port).toBe(16560);
    });

    it('throws ToolValidationError when no free port is found', async () => {
      // Use an impossible port with maxTries=1 and mock that isPortFree returns false
      // We can force this by binding a real server to the target port first
      const net = await import('node:net');
      const server = net.createServer();
      const occupyPort = BASE_PORT + 30;
      await new Promise<void>((resolve, reject) => {
        server.listen(occupyPort, '127.0.0.1', (err?: Error) => {
          if (err) reject(err);
          else resolve();
        });
      });

      try {
        // With maxTries=1, it should only try the occupied port
        await expect(findFreePort('127.0.0.1', occupyPort, { maxTries: 1 })).rejects.toThrow(
          /No free port found/,
        );
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('uses default options when none provided', async () => {
      const port = await findFreePort('127.0.0.1', BASE_PORT + 40);
      expect(port).toBe(BASE_PORT + 40);
    });

    it('iterates when startPort is occupied', async () => {
      const net = await import('node:net');
      const server = net.createServer();
      const occupyPort = BASE_PORT + 50;
      await new Promise<void>((resolve, reject) => {
        server.listen(occupyPort, '127.0.0.1', (err?: Error) => {
          if (err) reject(err);
          else resolve();
        });
      });

      try {
        // maxTries=2 so it can try occupyPort and then the next one
        const port = await findFreePort('127.0.0.1', occupyPort, { maxTries: 3 });
        expect(port).toBe(occupyPort + 1);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });

  describe('listenWithRetry (bind-time EADDRINUSE safety net)', () => {
    it('advances past an occupied port and resolves the port actually bound', async () => {
      const net = await import('node:net');
      const blocker = net.createServer();
      const blockedPort = BASE_PORT + 60;
      await new Promise<void>((resolve, reject) => {
        blocker.listen(blockedPort, '127.0.0.1', (err?: Error) => {
          if (err) reject(err);
          else resolve();
        });
      });

      const server = net.createServer();
      try {
        const bound = await listenWithRetry(server, '127.0.0.1', blockedPort, { maxTries: 3 });
        expect(bound).toBe(blockedPort + 1);
        expect(server.listening).toBe(true);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await new Promise<void>((resolve) => blocker.close(() => resolve()));
      }
    });

    it('rejects with the last EADDRINUSE once attempts are exhausted', async () => {
      const net = await import('node:net');
      const blocker = net.createServer();
      const blockedPort = BASE_PORT + 70;
      await new Promise<void>((resolve, reject) => {
        blocker.listen(blockedPort, '127.0.0.1', (err?: Error) => {
          if (err) reject(err);
          else resolve();
        });
      });

      const server = net.createServer();
      try {
        await expect(
          listenWithRetry(server, '127.0.0.1', blockedPort, { maxTries: 1 }),
        ).rejects.toMatchObject({ code: 'EADDRINUSE' });
      } finally {
        await new Promise<void>((resolve) => blocker.close(() => resolve()));
      }
    });

    it('rejects immediately without advancing on a non-EADDRINUSE error', async () => {
      const net = await import('node:net');
      // An out-of-range port makes listen() throw synchronously (RangeError);
      // the promise executor converts the throw into a rejection, and the
      // retry loop must NOT treat it as a retryable EADDRINUSE.
      const server = net.createServer();
      await expect(listenWithRetry(server, '127.0.0.1', 70_000, { maxTries: 5 })).rejects.toThrow(
        /Port/i,
      );
      expect(server.listening).toBe(false);
    });

    it('propagates a probe-detected non-EADDRINUSE errno instead of advancing', async () => {
      const net = await import('node:net');
      // 192.0.2.0/24 is TEST-NET-1 — never assigned to a local interface —
      // so the probe fails with EADDRNOTAVAIL on every platform. The retry
      // loop must reject with the REAL errno (fail-fast), never treat it as
      // contention and advance to another port on the same dead address.
      const server = net.createServer();
      await expect(
        listenWithRetry(server, '192.0.2.123', BASE_PORT + 90, { maxTries: 5 }),
      ).rejects.toMatchObject({ code: 'EADDRNOTAVAIL' });
      expect(server.listening).toBe(false);
    });

    it('rejects with the last EADDRINUSE after N consecutive occupied ports', async () => {
      const net = await import('node:net');
      const base = BASE_PORT + 80;
      const blockers = [0, 1, 2].map(() => net.createServer());
      for (const [i, blocker] of blockers.entries()) {
        await new Promise<void>((resolve, reject) => {
          blocker.listen(base + i, '127.0.0.1', (err?: Error) => {
            if (err) reject(err);
            else resolve();
          });
        });
      }

      const server = net.createServer();
      try {
        await expect(
          listenWithRetry(server, '127.0.0.1', base, { maxTries: 3 }),
        ).rejects.toMatchObject({ code: 'EADDRINUSE' });
        expect(server.listening).toBe(false);
      } finally {
        await Promise.all(
          blockers.map((b) => new Promise<void>((resolve) => b.close(() => resolve()))),
        );
      }
    });
  });
});

// B-07: migrated from packages/webui/tests/server/port-utils.test.ts (verbatim,
// import path rewritten to the local `../src/server/...` resolution). The
// webui copy used an ephemeral-port discovery helper (`occupy(0)` → learn the
// assigned port) rather than a hard-coded BASE_PORT — that pattern matters
// under full-suite load where many workers grab 23456-series sockets. The
// server's hard-coded range was a deliberate trade for test isolation; the
// webui variant is the regression guard for the CI-load path.
describe('isPortFree (webui variant — ephemeral-port discovery)', () => {
  const HOST2 = '127.0.0.1';
  const servers: import('net').Server[] = [];

  function occupy(port: number): Promise<import('net').Server> {
    return new Promise((resolve, reject) => {
      const srv = import('node:net').then((m) => m.createServer());
      srv
        .then((s) => {
          s.once('error', reject);
          s.listen(port, HOST2, () => {
            servers.push(s);
            resolve(s);
          });
        })
        .catch(reject);
    });
  }

  it('reports an occupied port as not free, and a free one as free', async () => {
    // Grab an ephemeral port, learn its number, then probe it.
    const srv = await occupy(0);
    const addr = srv.address();
    if (!addr || typeof addr === 'string') throw new Error('bad address');
    const taken = addr.port;
    expect(await isPortFree(HOST2, taken)).toBe(false);

    // Close it and confirm it frees up.
    await new Promise<void>((r) => srv.close(() => r()));
    expect(await isPortFree(HOST2, taken)).toBe(true);
  });
});

describe('findFreePort (webui variant — ephemeral-port discovery)', () => {
  const HOST2 = '127.0.0.1';
  const servers: import('net').Server[] = [];

  function occupy(port: number): Promise<import('net').Server> {
    return new Promise((resolve, reject) => {
      import('node:net').then((m) => {
        const srv = m.createServer();
        srv.once('error', reject);
        srv.listen(port, HOST2, () => {
          servers.push(srv);
          resolve(srv);
        });
      });
    });
  }

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))),
    );
  });

  it('returns the start port when it is free', async () => {
    const srv = await occupy(0);
    const addr = srv.address();
    if (!addr || typeof addr === 'string') throw new Error('bad address');
    const known = addr.port;
    await new Promise<void>((r) => srv.close(() => r()));
    expect(await findFreePort(HOST2, known)).toBe(known);
  });

  it('advances past an occupied port to the next free one', async () => {
    // Occupy an ephemeral port, then ask findFreePort to start there. It must
    // skip the taken port and return a higher one.
    const srv = await occupy(0);
    const addr = srv.address();
    if (!addr || typeof addr === 'string') throw new Error('bad address');
    const taken = addr.port;
    // Start at an OS-assigned ephemeral port. Under full-suite + coverage load,
    // many parallel workers hold ephemeral sockets, so the default 200-port scan
    // window above `taken` can be entirely occupied and throw. A generous
    // maxTries makes exhaustion effectively impossible while still proving the
    // skip-occupied-port behaviour (the call returns on the first free port).
    const found = await findFreePort(HOST2, taken, { maxTries: 2000 });
    expect(found).toBeGreaterThan(taken);
    expect(await isPortFree(HOST2, found)).toBe(true);
  });

  it('honors the exclude set even when the port is free', async () => {
    const srv = await occupy(0);
    const addr = srv.address();
    if (!addr || typeof addr === 'string') throw new Error('bad address');
    const base = addr.port;
    await new Promise<void>((r) => srv.close(() => r()));
    // base is free now, but excluded → must return something else.
    const found = await findFreePort(HOST2, base, { exclude: new Set([base]) });
    expect(found).not.toBe(base);
  });

  it('throws when no free port is found within maxTries', async () => {
    const srv = await occupy(0);
    const addr = srv.address();
    if (!addr || typeof addr === 'string') throw new Error('bad address');
    const taken = addr.port;
    // maxTries=1 with the only candidate occupied → no free port.
    await expect(findFreePort(HOST2, taken, { maxTries: 1 })).rejects.toThrow(/No free port/);
  });
});
