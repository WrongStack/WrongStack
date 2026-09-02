import { describe, it, expect } from 'vitest';

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
