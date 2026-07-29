import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getKanbanServerConnection } from '../src/server/client.js';
import { kanbanProjectServerEndpoint } from '../src/server/endpoint.js';
import { KANBAN_PROJECT_SERVER_PROTOCOL_VERSION } from '../src/server/protocol.js';

const roots: string[] = [];
const servers: net.Server[] = [];
const sockets: net.Socket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe('Kanban IPC client frame draining', () => {
  it('processes an event and response coalesced in one socket chunk', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-kanban-frame-drain-'));
    roots.push(root);
    const endpoint = kanbanProjectServerEndpoint(root);
    const server = net.createServer((socket) => {
      sockets.push(socket);
      socket.setEncoding('utf8');
      socket.write(
        `${JSON.stringify({
          type: 'hello',
          protocolVersion: KANBAN_PROJECT_SERVER_PROTOCOL_VERSION,
          pid: process.pid,
          projectRoot: root,
          endpoint,
          storage: 'sqlite',
          databasePath: path.join(root, '_kanban.sqlite'),
          startedAt: new Date().toISOString(),
        })}\n`,
      );
      socket.once('data', (chunk: string) => {
        const request = JSON.parse(chunk.trim()) as { id: number };
        const event = {
          type: 'event',
          event: 'board.updated',
          data: { boardId: 'board-1' },
        };
        const response = {
          id: request.id,
          ok: true,
          result: {
            protocolVersion: KANBAN_PROJECT_SERVER_PROTOCOL_VERSION,
            pid: process.pid,
            projectRoot: root,
            endpoint,
            storage: 'sqlite',
            databasePath: path.join(root, '_kanban.sqlite'),
            startedAt: new Date().toISOString(),
            clients: 1,
            pendingRequests: 0,
          },
        };
        socket.write(`${JSON.stringify(event)}\n${JSON.stringify(response)}\n`);
      });
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(endpoint, resolve);
    });

    const connection = await getKanbanServerConnection(root);
    expect(connection).not.toBeNull();
    const events: string[] = [];
    connection!.subscribe((event) => events.push(event.event));

    const status = await connection!.request('ping', {}, { timeoutMs: 1_000 });

    expect(events).toEqual(['board.updated']);
    expect(status.pid).toBe(process.pid);
    sockets[0]?.destroy();
  });
});
