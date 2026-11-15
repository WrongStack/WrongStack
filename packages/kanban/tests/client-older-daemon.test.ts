/**
 * A Kanban daemon of an older release is replaced, not reused: the client asks it to stop with
 * the project's token and connects to the daemon of its own release that takes over the
 * endpoint. A daemon of the same release is reused as before.
 */
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { WRONGSTACK_RUNTIME_VERSION } from '@wrongstack/primitives';
import { afterEach, expect, it } from 'vitest';
import { closeKanbanServerConnections, getKanbanServerConnection } from '../src/server/client.js';
import { kanbanProjectServerEndpoint } from '../src/server/endpoint.js';
import {
  KANBAN_PROJECT_SERVER_METADATA_FILE,
  KANBAN_PROJECT_SERVER_PROTOCOL_VERSION,
} from '../src/server/protocol.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  closeKanbanServerConnections();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function project() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-kanban-older-'));
  await fs.mkdir(path.join(root, '.wrongstack'), { recursive: true });
  await fs.writeFile(
    path.join(root, '.wrongstack', KANBAN_PROJECT_SERVER_METADATA_FILE),
    JSON.stringify({ authToken: 'project-token' }),
  );
  const endpoint = kanbanProjectServerEndpoint(root);
  await fs.mkdir(path.dirname(endpoint), { recursive: true }).catch(() => {});
  cleanups.push(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(path.dirname(endpoint), { recursive: true, force: true }).catch(() => {});
  });
  return { root, endpoint };
}

/** A fake daemon of `version` that records the frames it receives. */
async function daemon(
  where: { root: string; endpoint: string },
  version: string,
  onShutdown?: () => void,
) {
  const frames: Array<Record<string, unknown>> = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
        const frame = JSON.parse(buffer.slice(0, nl)) as Record<string, unknown>;
        buffer = buffer.slice(nl + 1);
        frames.push(frame);
        if (frame['method'] === 'shutdown') onShutdown?.();
      }
    });
    socket.write(
      `${JSON.stringify({
        type: 'hello',
        runtimeVersion: version,
        protocolVersion: KANBAN_PROJECT_SERVER_PROTOCOL_VERSION,
        pid: 999_999_999,
        projectRoot: where.root,
        endpoint: where.endpoint,
        storage: 'sqlite',
        databasePath: path.join(where.root, '_kanban.sqlite'),
        startedAt: new Date().toISOString(),
      })}\n`,
    );
  });
  await new Promise<void>((resolve) => server.listen(where.endpoint, resolve));
  const stop = () =>
    new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    });
  cleanups.push(stop);
  return { frames, stop };
}

it('asks an older daemon to stop and connects to the one of its own release', async () => {
  const where = await project();
  let replaced!: Promise<unknown>;
  const older = await daemon(where, '1.0.0', () => {
    replaced = older.stop().then(() => daemon(where, WRONGSTACK_RUNTIME_VERSION));
  });
  const connection = await getKanbanServerConnection(where.root);
  const current = (await replaced) as Awaited<ReturnType<typeof daemon>>;
  expect(connection).not.toBeNull();
  expect(older.frames).toEqual([
    expect.objectContaining({ method: 'shutdown', authToken: 'project-token' }),
  ]);
  expect(current.frames).toEqual([]);
});

it('reuses a daemon of the same release', async () => {
  const where = await project();
  const same = await daemon(where, WRONGSTACK_RUNTIME_VERSION);
  expect(await getKanbanServerConnection(where.root)).not.toBeNull();
  expect(same.frames).toEqual([]);
});
