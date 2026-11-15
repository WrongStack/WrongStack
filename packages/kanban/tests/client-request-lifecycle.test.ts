import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getKanbanServerConnection } from '../src/server/client.js';
import { kanbanProjectServerEndpoint } from '../src/server/endpoint.js';
import { KANBAN_PROJECT_SERVER_PROTOCOL_VERSION } from '../src/server/protocol.js';

type Connection = NonNullable<Awaited<ReturnType<typeof getKanbanServerConnection>>>;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function connect() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kanban-request-lifecycle-'));
  const endpoint = kanbanProjectServerEndpoint(root);
  if (process.platform !== 'win32') await fs.mkdir(path.dirname(endpoint), { recursive: true });
  const peers = new Set<net.Socket>();
  let connection: Connection | null = null;
  const server = net.createServer((socket) => {
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
    connection?.close();
    // Also clean orphaned timers left by the pre-fix implementation in red runs.
    if (connection) {
      const state = connection as unknown as {
        pending: Map<number, { timer: ReturnType<typeof setTimeout> }>;
      };
      for (const entry of state.pending.values()) clearTimeout(entry.timer);
      state.pending.clear();
    }
    for (const peer of peers) peer.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, resolve);
  });
  connection = await getKanbanServerConnection(root);
  if (!connection) throw new Error('Kanban IPC is disabled');
  const state = connection as unknown as { pending: Map<number, unknown>; socket: net.Socket };
  return { connection, state };
}

describe('Kanban client request lifecycle', () => {
  for (const ok of [false, 0, 'true', null]) {
    it(`never treats an unsuccessful response flag ${JSON.stringify(ok)} as success`, async () => {
      const { connection, state } = await connect();
      const pending = connection.request('ping', {});
      void pending.catch(() => undefined);
      await new Promise<void>((resolve) => setImmediate(resolve));
      const id = state.pending.keys().next().value;
      expect(id).toBeDefined();
      state.socket.emit(
        'data',
        JSON.stringify({ id, ok, error: { code: 'VALIDATION', message: 'fixture failure' } }) +
          '\n',
      );
      await expect(pending).rejects.toThrow('fixture failure');
      expect(state.pending.size).toBe(0);
    });
  }

  it('rejects a request closed while resuming from hello without retaining it', async () => {
    const { connection, state } = await connect();
    const pending = connection.request('ping', {});
    connection.close();
    await expect(pending).rejects.toThrow('Connection closed');
    expect(state.pending.size).toBe(0);
  });

  it('does not retain a request when serialization fails', async () => {
    const { connection, state } = await connect();
    const failure = new Error('cannot serialize parameters');
    const params = {
      toJSON() {
        throw failure;
      },
    };
    await expect(connection.request('ping', params as never)).rejects.toBe(failure);
    expect(state.pending.size).toBe(0);
  });

  it('cleans a request whose socket write throws synchronously', async () => {
    const { connection, state } = await connect();
    const failure = new Error('socket write failed');
    vi.spyOn(state.socket, 'write').mockImplementation(() => {
      throw failure;
    });
    await expect(connection.request('ping', {})).rejects.toBe(failure);
    expect(state.pending.size).toBe(0);
  });

  it('clamps timeoutMs above 32-bit signed max instead of firing immediately (F364)', async () => {
    const { connection, state } = await connect();
    const pending = connection.request('ping', {}, { timeoutMs: 3_000_000_000 });
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    const id = state.pending.keys().next().value;
    expect(id).toBeDefined();
    state.socket.emit('data', `${JSON.stringify({ id, ok: true, result: { pong: true } })}\n`);
    await expect(pending).resolves.toEqual({ pong: true });
    expect(state.pending.size).toBe(0);
  });
});
