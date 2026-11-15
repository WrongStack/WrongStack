/**
 * A Session Catalog daemon of an older release is replaced, not reused: the client asks it to
 * stop with the project's token and uses the daemon of its own release that takes over the
 * endpoint. A daemon of the same release is reused as before.
 */
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { WRONGSTACK_RUNTIME_VERSION } from '@wrongstack/primitives';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { SessionCatalogProjectClient } from '../../src/session-catalog/client.js';
import {
  sessionCatalogProjectServerEndpoint,
  sessionCatalogProjectServerMetadataPath,
} from '../../src/session-catalog/endpoint.js';
import { SESSION_CATALOG_PROTOCOL_VERSION } from '../../src/session-catalog/protocol.js';

let tmp: string;
const cleanups: Array<() => Promise<void>> = [];
beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-catalog-older-')));
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await fs.rm(tmp, { recursive: true, force: true });
});

/** A catalog daemon stand-in of `version` that records frames and answers `answer`. */
async function daemon(
  projectDir: string,
  projectRoot: string,
  version: string,
  answer: unknown,
  onShutdown?: () => void,
) {
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(
    sessionCatalogProjectServerMetadataPath(projectDir),
    JSON.stringify({ pid: process.pid, projectRoot, authToken: 'project-token' }),
  );
  const endpoint = sessionCatalogProjectServerEndpoint(projectDir);
  const frames: Array<Record<string, unknown>> = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.setEncoding('utf8');
    socket.write(
      `${JSON.stringify({
        type: 'hello',
        runtimeVersion: version,
        protocolVersion: SESSION_CATALOG_PROTOCOL_VERSION,
        pid: 999_999_999,
        projectDir,
        projectRoot,
        endpoint,
        databasePath: path.join(projectDir, 'catalog.db'),
        instanceId: 'fake',
        startedAt: new Date().toISOString(),
      })}\n`,
    );
    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
        const frame = JSON.parse(buffer.slice(0, i)) as Record<string, unknown>;
        buffer = buffer.slice(i + 1);
        frames.push(frame);
        if (frame['type'] === 'shutdown') onShutdown?.();
        else
          socket.write(
            `${JSON.stringify({ type: 'response', id: frame['id'], ok: true, result: answer })}\n`,
          );
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(endpoint, resolve));
  const stop = () =>
    new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    });
  cleanups.push(stop);
  return { frames, stop };
}

it('asks an older daemon to stop and uses the one of its own release', async () => {
  const projectDir = path.join(tmp, 'project-dir');
  const root = path.join(tmp, 'repo');
  await fs.mkdir(root);
  let replaced!: Promise<unknown>;
  const older = await daemon(projectDir, root, '1.0.0', ['older'], () => {
    replaced = older
      .stop()
      .then(() => daemon(projectDir, root, WRONGSTACK_RUNTIME_VERSION, ['current']));
  });
  const client = new SessionCatalogProjectClient({ projectDir, projectRoot: root });
  try {
    await expect(client.call('list_live', {}, { timeoutMs: 8_000 })).resolves.toEqual(['current']);
    await replaced;
    expect(older.frames).toEqual([
      expect.objectContaining({
        type: 'shutdown',
        reason: 'older-release-replacement',
        authToken: 'project-token',
      }),
    ]);
  } finally {
    await client.close();
  }
});

it('reuses a daemon of the same release', async () => {
  const projectDir = path.join(tmp, 'project-dir');
  const root = path.join(tmp, 'repo');
  await fs.mkdir(root);
  const same = await daemon(projectDir, root, WRONGSTACK_RUNTIME_VERSION, ['same']);
  const client = new SessionCatalogProjectClient({ projectDir, projectRoot: root });
  try {
    await expect(client.call('list_live', {}, { timeoutMs: 8_000 })).resolves.toEqual(['same']);
    expect(same.frames.map((frame) => frame['type'])).toEqual(['request']);
  } finally {
    await client.close();
  }
});
