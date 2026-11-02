import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeKanbanServerConnections, getKanbanServerConnection } from '../src/server/client.js';
import { kanbanProjectServerEndpoint } from '../src/server/endpoint.js';
import { bridgeKanbanSupervisor } from '../src/server/kanban-supervisor-bridge.js';
import { KANBAN_PROJECT_SERVER_PROTOCOL_VERSION } from '../src/server/protocol.js';

/**
 * A bridge disposed while its connect is in flight must release the connection
 * that connect produced. `getKanbanServerConnection` caches process-wide and
 * opens a ref'd socket, so dropping the late result left a handle nobody owned
 * — the shape that kept a webui-server in-process restart (and a Vitest worker)
 * alive. The handshake is gated so the ordering is forced, not timed.
 */

const HELLO = `${JSON.stringify({
  type: 'hello',
  protocolVersion: KANBAN_PROJECT_SERVER_PROTOCOL_VERSION,
})}\n`;
const BOUND_MS = 5_000;

interface FakeDaemon {
  projectRoot: string;
  accepted: Promise<net.Socket>;
  closed: Promise<void>;
  /** Release the withheld handshake for the accepted socket. */
  sendHello: () => Promise<void>;
  shutdown: () => Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];

function bounded<T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
    timer.unref?.();
  });
  return Promise.race([promise, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function startFakeDaemon(label: string): Promise<FakeDaemon> {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), `ws-kanban-bridge-${label}-`));
  fs.mkdirSync(path.join(projectRoot, '.wrongstack'), { recursive: true });
  const endpoint = kanbanProjectServerEndpoint(projectRoot);
  if (process.platform !== 'win32') {
    fs.mkdirSync(path.dirname(endpoint), { recursive: true, mode: 0o700 });
  }

  let resolveAccepted!: (socket: net.Socket) => void;
  let resolveClosed!: () => void;
  const accepted = new Promise<net.Socket>((resolve) => {
    resolveAccepted = resolve;
  });
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let current: net.Socket | undefined;

  const server = net.createServer((socket) => {
    current = socket;
    socket.on('error', () => undefined);
    socket.once('close', () => resolveClosed());
    resolveAccepted(socket);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, () => resolve());
  });

  const daemon: FakeDaemon = {
    projectRoot,
    accepted,
    closed,
    sendHello: async () => {
      const socket = await accepted;
      socket.write(HELLO);
    },
    shutdown: async () => {
      current?.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  cleanups.push(async () => {
    await daemon.shutdown();
  });
  return daemon;
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  closeKanbanServerConnections();
});

describe('bridgeKanbanSupervisor disposal during connect', () => {
  it('releases the connection a disposed bridge’s in-flight connect produced', async () => {
    const daemon = await startFakeDaemon('race');
    const dispose = bridgeKanbanSupervisor(daemon.projectRoot, () => undefined);

    const socket = await bounded(daemon.accepted, BOUND_MS);
    expect(socket).not.toBe('timeout');

    // Forced order: the owner is gone before the handshake can settle the connect.
    dispose();
    await daemon.sendHello();

    await expect(bounded(daemon.closed, BOUND_MS)).resolves.not.toBe('timeout');
  });

  it('keeps a subscribed connection open when the bridge is disposed later', async () => {
    const daemon = await startFakeDaemon('control');
    const dispose = bridgeKanbanSupervisor(daemon.projectRoot, () => undefined);

    const socket = await bounded(daemon.accepted, BOUND_MS);
    expect(socket).not.toBe('timeout');
    await daemon.sendHello();

    // Gate on the public observable: a subscribed connection is not evictable.
    let evictable: boolean | undefined;
    const deadline = Date.now() + BOUND_MS;
    for (;;) {
      const conn = await getKanbanServerConnection(daemon.projectRoot);
      evictable = conn?.isEvictable();
      if (evictable === false || Date.now() > deadline) break;
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(evictable).toBe(false);
    await expect(bounded(daemon.closed, 150)).resolves.toBe('timeout');

    dispose();
  });
});
