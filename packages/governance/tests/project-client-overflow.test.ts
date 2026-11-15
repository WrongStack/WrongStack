import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { governanceProjectServerEndpoint } from '../src/ipc-endpoint.js';
import { GovernanceProjectClient } from '../src/project-client.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

describe('GovernanceProjectClient timeout clamping (F387)', () => {
  it('clamps timeoutMs above 32-bit signed max instead of timing out in 1ms', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'f387-gov-'));
    const endpoint = governanceProjectServerEndpoint(root);
    if (process.platform !== 'win32') await fs.mkdir(path.dirname(endpoint), { recursive: true });

    const peers = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      peers.add(socket);
      socket.on('data', (chunk) => {
        const env = JSON.parse(chunk.toString('utf8').trim()) as { request: { requestId: string } };
        setTimeout(() => {
          socket.write(
            `${JSON.stringify({ requestId: env.request.requestId, ok: true, result: { pong: true } })}\n`,
          );
        }, 30);
      });
    });

    cleanups.push(async () => {
      for (const p of peers) p.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(root, { recursive: true, force: true });
    });

    await new Promise<void>((resolve) => server.listen(endpoint, resolve));

    const client = new GovernanceProjectClient(root, { token: 't', projectRoot: root } as never, {
      timeoutMs: 3_000_000_000,
    });
    const res = await client.request({ requestId: 'r1', kind: 'ping' });
    expect(res.ok).toBe(true);
  });
});
