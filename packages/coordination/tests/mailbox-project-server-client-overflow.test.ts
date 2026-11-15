import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MailboxProjectServerConnection } from '../src/mailbox-project-server-client.js';
import { mailboxProjectServerEndpoint } from '../src/mailbox-project-server-endpoint.js';
import { MAILBOX_PROJECT_SERVER_PROTOCOL_VERSION } from '../src/mailbox-project-server-protocol.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

describe('MailboxProjectServerConnection.request timeout clamping (F389)', () => {
  it('clamps timeoutMs above 32-bit signed max instead of timing out in 1ms', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'f389-mb-'));
    const endpoint = mailboxProjectServerEndpoint(root);
    if (process.platform !== 'win32') await fs.mkdir(path.dirname(endpoint), { recursive: true });

    const peers = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      peers.add(socket);
      socket.write(
        `${JSON.stringify({
          type: 'hello',
          protocolVersion: MAILBOX_PROJECT_SERVER_PROTOCOL_VERSION,
          pid: process.pid,
          projectDir: root,
          endpoint,
          startedAt: new Date().toISOString(),
        })}\n`,
      );
      socket.on('data', (chunk) => {
        for (const line of chunk.toString('utf8').split('\n').filter(Boolean)) {
          const msg = JSON.parse(line) as { id: number };
          setTimeout(() => {
            socket.write(
              `${JSON.stringify({ type: 'response', id: msg.id, ok: true, result: {} })}\n`,
            );
          }, 30);
        }
      });
    });

    const client = new MailboxProjectServerConnection(root);
    cleanups.push(async () => {
      client.close();
      for (const p of peers) p.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(root, { recursive: true, force: true });
    });

    await new Promise<void>((resolve) => server.listen(endpoint, resolve));
    await client.connect();

    await expect(
      (client as unknown as { request: (m: unknown, t: number) => Promise<unknown> }).request(
        { type: 'ping' },
        3_000_000_000,
      ),
    ).resolves.toEqual({});
  });
});
