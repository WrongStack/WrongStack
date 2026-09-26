/**
 * A client that needs the project's Session Catalog daemon while the previous
 * one is still on its way out.
 *
 * The daemon the client starts finds the endpoint held, reads it as "already
 * owned" and exits. A moment later the old owner is gone, and nobody binds the
 * endpoint. The client started a daemon only once, so it waited out its whole
 * window and failed with `connect ENOENT` (the hq-mailbox-mutation flake: each
 * case shuts the project's daemon down and the next one starts it again). It
 * now starts another once its own has exited and no owner is left.
 */
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionCatalogProjectClient } from '../src/session-catalog/client.js';
import {
  sessionCatalogProjectServerEndpoint,
  sessionCatalogProjectServerMetadataPath,
} from '../src/session-catalog/endpoint.js';
import {
  connectFrame,
  makeTempRoot,
  sleep,
  waitForEndpointClosed,
  waitForMetadataFile,
  waitForMetadataRemoval,
} from './helpers/project-server-harness.js';

const DIAG_ENV = 'WRONGSTACK_CATALOG_DAEMON_LOG';
const previousDiag = process.env[DIAG_ENV];

afterEach(() => {
  if (previousDiag === undefined) delete process.env[DIAG_ENV];
  else process.env[DIAG_ENV] = previousDiag;
});

describe('SessionCatalogProjectClient after a lost election', () => {
  it('starts another daemon once the owner on its way out is gone', async () => {
    const fixture = await makeTempRoot('session-catalog-lost-election');
    const endpoint = sessionCatalogProjectServerEndpoint(fixture.root);
    const metadataPath = sessionCatalogProjectServerMetadataPath(fixture.root);
    // The spawned daemons' exits are recorded here (the client's opt-in
    // diagnostic), which tells the test when the first one has given up.
    const diagFile = path.join(
      os.tmpdir(),
      `wstack-lost-election-${process.pid}-${Date.now()}.log`,
    );
    process.env[DIAG_ENV] = diagFile;

    // The old owner: holds the endpoint, answers nobody, has no metadata.
    const sockets = new Set<net.Socket>();
    const holder = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => holder.listen(endpoint, resolve));
    const releaseHolder = (async () => {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const log = fs.existsSync(diagFile) ? fs.readFileSync(diagFile, 'utf8') : '';
        if (/EXIT code=/.test(log)) break;
        await sleep(25);
      }
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => holder.close(() => resolve()));
    })();

    const client = new SessionCatalogProjectClient({
      projectDir: fixture.root,
      projectRoot: fixture.root,
    });
    try {
      await expect(client.ping()).resolves.toMatchObject({ catalogRows: expect.any(Number) });
      expect(fs.readFileSync(diagFile, 'utf8')).toMatch(/EXIT code=0/);
    } finally {
      await releaseHolder;
      await client.close();
    }

    // Stop the daemon that won, as the harness tests do.
    const metadata = await waitForMetadataFile<{ authToken: string }>(metadataPath);
    const raw = await connectFrame(endpoint);
    expect((await raw.nextFrame()).type).toBe('hello');
    raw.socket.write(
      `${JSON.stringify({ type: 'shutdown', id: 99, reason: 'test', authToken: metadata.authToken })}\n`,
    );
    expect(await raw.nextFrame()).toMatchObject({ type: 'response', id: 99, ok: true });
    raw.socket.destroy();
    await waitForMetadataRemoval(metadataPath);
    await waitForEndpointClosed(endpoint);
    fs.rmSync(diagFile, { force: true });
    await fixture.release();
  }, 40_000);
});
