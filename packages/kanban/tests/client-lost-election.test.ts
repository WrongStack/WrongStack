/**
 * The Kanban daemon this client starts can exit at once: it finds the
 * endpoint still held by one on its way out and reads that as "already
 * owned". Once the old one is gone nobody binds the endpoint, and a client
 * that started a daemon only once waited out its whole window against it. It
 * now starts another when its own has exited.
 */
import * as fsp from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const spawnState = vi.hoisted(() => ({ onSpawn: [] as Array<() => unknown> }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: vi.fn(() => {
      const next = spawnState.onSpawn.shift();
      return next ? next() : { pid: undefined, exitCode: 1, signalCode: null, unref() {} };
    }),
  };
});

// The source tree has no built `project-server.js` next to the client; let
// the client believe it does so it reaches `spawn`.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: (p: Parameters<typeof actual.existsSync>[0]) =>
      String(p).endsWith('project-server.js') || actual.existsSync(p),
  };
});

import { spawn } from 'node:child_process';
import { closeKanbanServerConnections, getKanbanServerConnection } from '../src/server/client.js';
import { kanbanProjectServerEndpoint } from '../src/server/endpoint.js';
import { KANBAN_PROJECT_SERVER_PROTOCOL_VERSION } from '../src/server/protocol.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  closeKanbanServerConnections();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  spawnState.onSpawn.length = 0;
  vi.mocked(spawn).mockClear();
});

describe('Kanban client after a lost election', () => {
  it('starts another daemon when the one it started has exited', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'kanban-lost-election-'));
    const endpoint = kanbanProjectServerEndpoint(root);
    if (process.platform !== 'win32') await fsp.mkdir(path.dirname(endpoint), { recursive: true });
    const peers = new Set<net.Socket>();
    const daemon = net.createServer((socket) => {
      peers.add(socket);
      socket.write(
        `${JSON.stringify({
          type: 'hello',
          protocolVersion: KANBAN_PROJECT_SERVER_PROTOCOL_VERSION,
          pid: process.pid,
          projectRoot: root,
          endpoint,
          storage: 'sqlite',
          databasePath: path.join(root, 'kanban.sqlite'),
          startedAt: new Date().toISOString(),
        })}\n`,
      );
    });
    cleanups.push(async () => {
      for (const peer of peers) peer.destroy();
      if (daemon.listening) await new Promise<void>((resolve) => daemon.close(() => resolve()));
      await fsp.rm(root, { recursive: true, force: true });
    });

    // First daemon: lost the election and is already gone.
    spawnState.onSpawn.push(() => ({ pid: 1, exitCode: 0, signalCode: null, unref() {} }));
    // Second daemon: binds the now free endpoint.
    spawnState.onSpawn.push(() => {
      daemon.listen(endpoint);
      return { pid: 2, exitCode: null, signalCode: null, unref() {} };
    });

    const connection = await getKanbanServerConnection(root);
    expect(connection).not.toBeNull();
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(2);
  });
});
