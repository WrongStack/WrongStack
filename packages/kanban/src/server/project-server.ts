/**
 * Kanban Project Server — IPC daemon
 *
 * Single shared process per project. Owns the kanban state for `projectRoot`.
 * Tools and other agents connect over a net.Socket (named pipe on Windows,
 * Unix domain socket elsewhere) and call typed methods from `protocol.ts`.
 *
 * Lifecycle:
 *   - Spawned detached via `client.ts` when first needed
 *   - Idle for `WRONGSTACK_KANBAN_SERVER_IDLE_MS` (default 5 minutes)
 *     with zero connected clients → exits cleanly
 *   - Hard stop on `shutdown` request or SIGTERM
 */
import * as fsPromises from 'node:fs/promises';
import * as net from 'node:net';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { KANBAN_DOMAIN_OPERATIONS } from '../domain-operations.js';
import { StaleWriteError } from '../manager/lifecycle.js';
import * as kanban from '../manager.js';
import { installKanbanStorageBackend } from '../storage-backend.js';
import type { KanbanBoard, KanbanEvent } from '../types.js';
import { kanbanProjectServerEndpoint } from './endpoint.js';
import { emitBoardEvent, subscribeToBoardEvents } from './event-emitter.js';
import {
  decodeKanbanDomainValue,
  encodeKanbanDomainValue,
  KANBAN_PROJECT_SERVER_PROTOCOL_VERSION,
  KANBAN_SERVER_METHODS,
  type KanbanErrorCode,
  type KanbanErrorResponse,
  type KanbanHelloFrame,
  type KanbanProjectServerInfo,
  type KanbanRequest,
  type KanbanServerEvent,
} from './protocol.js';
import { SqliteKanbanStorage } from './sqlite-storage.js';

export { kanbanProjectServerEndpoint } from './endpoint.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_IDLE_MS = 5 * 60_000;
/** How often to confirm the project root still exists (orphan guard). */
const ROOT_LIVENESS_CHECK_MS = 60_000;
const CLIENT_LEASE_MS = 45_000;
const CLIENT_LEASE_SWEEP_MS = 15_000;
const MAX_FRAME_CHARS = 8 * 1024 * 1024;
const MAX_PARALLEL_REQUESTS_PER_CLIENT = 32;

interface ClientState {
  socket: net.Socket;
  buffer: string;
  /** Count of in-flight request handlers. Used to cap concurrent work per
   *  client. Note: handlers are NOT cancelled on disconnect — the mutation has
   *  already entered the storage layer and may have committed server-side. A
   *  lost response is accepted per the at-most-once-execution contract. */
  inflightRequests: number;
  lastSeenAt: number;
}

let projectRoot = '';
let endpoint = '';
let serverInfo: KanbanProjectServerInfo | null = null;
let stopping = false;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let livenessTimer: ReturnType<typeof setInterval> | undefined;
let leaseTimer: ReturnType<typeof setInterval> | undefined;
const clients = new Set<ClientState>();
let sqliteStorage: SqliteKanbanStorage | null = null;
let uninstallStorageBackend: (() => void) | null = null;

/**
 * Module-scope so `stop()` can actually close it. While this lived as a `const`
 * inside `main()` it was unreachable from `stop()`, so the listening pipe handle
 * — a ref'd libuv handle — kept the process alive forever after the idle timer
 * fired: the daemon set `stopping = true` and then lingered as a ~45MB zombie
 * that accepted connections only to destroy them. Four such orphans were found
 * running against deleted temp directories.
 */
let server: net.Server | null = null;

// ─── Frame I/O ───────────────────────────────────────────────────────────────

/**
 * Cap on outbound bytes queued for one client before it is dropped.
 *
 * `socket.write()` reporting `false` is the signal to stop producing; this
 * server broadcasts board events to every client, so ignoring it let a single
 * client that stopped reading grow the owner's heap by one queued broadcast at
 * a time, without limit. Board state lives in SQLite, so a dropped client
 * re-reads it on reconnect and loses only events it was already too far behind
 * to have handled.
 */
const MAX_CLIENT_WRITE_BUFFER_BYTES = 8 * 1024 * 1024;

function writeFrame(socket: net.Socket, encoded: string): void {
  if (socket.destroyed) return;
  if (socket.writableLength > MAX_CLIENT_WRITE_BUFFER_BYTES) {
    socket.destroy(new Error('Kanban client fell too far behind on reads'));
    return;
  }
  socket.write(encoded);
}

function sendFrame(socket: net.Socket, frame: unknown): void {
  writeFrame(socket, JSON.stringify(frame) + '\n');
}

/**
 * Encode once, write to every client — stringifying inside the loop produced
 * one copy of the payload per connected client. Board snapshots are the large
 * frames here, so the multiple showed up directly as allocation churn.
 */
function broadcastEvent(ev: KanbanServerEvent): void {
  if (clients.size === 0) return;
  const encoded = JSON.stringify(ev) + '\n';
  for (const state of clients) {
    try {
      writeFrame(state.socket, encoded);
    } catch {
      state.socket.destroy();
    }
  }
}

// ─── Server lifecycle ────────────────────────────────────────────────────────

function scheduleIdleStop(): void {
  if (stopping || clients.size > 0) return;
  if (idleTimer) clearTimeout(idleTimer);
  const idleInput = Number(process.env['WRONGSTACK_KANBAN_SERVER_IDLE_MS']);
  const idleMs = Number.isFinite(idleInput) && idleInput >= 100 ? idleInput : DEFAULT_IDLE_MS;
  idleTimer = setTimeout(() => void stop('idle-timeout'), idleMs);
  idleTimer.unref?.();
}

async function stop(_reason: string, gracefulSocket?: net.Socket): Promise<void> {
  if (stopping) return;
  stopping = true;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = undefined;
  if (livenessTimer) clearInterval(livenessTimer);
  livenessTimer = undefined;
  if (leaseTimer) clearInterval(leaseTimer);
  leaseTimer = undefined;
  for (const state of clients) {
    // Handlers are intentionally NOT aborted here: once a request reaches the
    // storage layer the mutation may have committed server-side. Aborting would
    // give the false impression that the mutation was rolled back. The handler
    // will finish and write to a destroyed socket, which is silently dropped.
    if (state.socket === gracefulSocket) state.socket.end();
    else state.socket.destroy();
  }
  clients.clear();
  // Close the listener, or the ref'd handle keeps the event loop — and the
  // process — alive indefinitely. Every sibling daemon (tools, sage, chronicle,
  // mailbox) does this; kanban was the one that did not.
  if (server) {
    const listener = server;
    server = null;
    await new Promise<void>((resolve) => listener.close(() => resolve()));
  }
  if (process.platform !== 'win32' && endpoint) {
    await fsPromises.rm(endpoint, { force: true }).catch(() => {});
  }
  uninstallStorageBackend?.();
  uninstallStorageBackend = null;
  sqliteStorage?.close();
  sqliteStorage = null;
}

async function ensureParentDir(): Promise<void> {
  if (process.platform === 'win32') return;
  const dir = path.dirname(endpoint);
  await fsPromises.mkdir(dir, { recursive: true }).catch(() => undefined);
}

// ─── Method registrations ────────────────────────────────────────────────────
//
// All handlers are async to give the call site a uniform shape. The `direct`
// wrapper strips the `Promise` so we can access `.id` and other properties
// on the resolved value.

type Handler = (params: any) => Promise<unknown>;
const methods = new Map<string, Handler>();
const protocolMethods = new Set<string>(KANBAN_SERVER_METHODS);

function defineMethod(name: string, handler: Handler): void {
  methods.set(name, handler);
}

function invalid(message: string): never {
  throw { code: 'INVALID_INPUT', message };
}

defineMethod('ping', async () => ({
  ...serverInfo!,
  clients: clients.size,
  pendingRequests: sumActive(),
}));

defineMethod('shutdown', async () => {
  return { stopping: true };
});

const domainOperationSet = new Set<string>(KANBAN_DOMAIN_OPERATIONS);
defineMethod('domainCall', async ({ operation, wireArgs }) => {
  if (!domainOperationSet.has(operation)) {
    invalid('domainCall requires an allowed operation');
  }
  const args = decodeKanbanDomainValue(wireArgs);
  if (!Array.isArray(args)) {
    invalid('domainCall requires encoded args[]');
  }
  const handler = (kanban as Record<string, unknown>)[operation];
  if (typeof handler !== 'function') {
    invalid(`Kanban domain operation is unavailable: ${operation}`);
  }
  const result = await (handler as (root: string, ...operationArgs: unknown[]) => unknown)(
    projectRoot,
    ...args,
  );
  return encodeKanbanDomainValue(result);
});

function ownerStorage(): SqliteKanbanStorage {
  if (!sqliteStorage) throw new Error('Kanban SQLite owner is not ready');
  return sqliteStorage;
}

defineMethod('storageListBoardIds', async () => ownerStorage().listBoardIds());
defineMethod('storageReadBoard', async ({ boardRef }: { boardRef: string }) => {
  if (!boardRef) invalid('storageReadBoard requires boardRef');
  return ownerStorage().readBoard(boardRef);
});
defineMethod(
  'storageWriteBoard',
  async ({ board, expectedRevision }: { board: KanbanBoard; expectedRevision?: number }) => {
    if (!board?.id) invalid('storageWriteBoard requires board.id');
    await ownerStorage().writeBoard(board, expectedRevision);
    return { written: true };
  },
);
defineMethod(
  'storageAppendEvent',
  async ({ boardId, event }: { boardId: string; event: KanbanEvent }) => {
    if (!boardId || !event) invalid('storageAppendEvent requires boardId and event');
    await ownerStorage().appendEvent(boardId, event);
    return { appended: true };
  },
);
defineMethod('storageReadEvents', async ({ boardRef }: { boardRef: string }) => {
  if (!boardRef) invalid('storageReadEvents requires boardRef');
  return ownerStorage().readEvents(boardRef);
});
defineMethod('storageDeleteBoard', async ({ boardRef }: { boardRef: string }) => {
  if (!boardRef) invalid('storageDeleteBoard requires boardRef');
  return ownerStorage().deleteBoard(boardRef);
});
defineMethod('storageReadMetadata', async ({ key }: { key: string }) => {
  if (!key) invalid('storageReadMetadata requires key');
  return ownerStorage().readMetadata(key);
});
defineMethod('storageWriteMetadata', async ({ key, value }: { key: string; value: string }) => {
  if (!key || typeof value !== 'string') {
    invalid('storageWriteMetadata requires key and string value');
  }
  await ownerStorage().writeMetadata(key, value);
  return { written: true };
});

function sumActive(): number {
  let total = 0;
  for (const state of clients) total += state.inflightRequests;
  return total;
}

function errorFromThrown(value: unknown): KanbanErrorResponse['error'] {
  if (value && typeof value === 'object' && 'code' in value && 'message' in value) {
    const v = value as { code: KanbanErrorCode; message: string };
    return { code: v.code, message: v.message };
  }
  if (value instanceof StaleWriteError) {
    return { code: 'STALE_WRITE', message: value.message };
  }
  if (value instanceof Error) {
    return { code: 'INTERNAL_ERROR', message: value.message, cause: value.stack ?? null };
  }
  return { code: 'INTERNAL_ERROR', message: String(value) };
}

// ─── Per-client request loop ─────────────────────────────────────────────────

function processRequest(state: ClientState, req: KanbanRequest): void {
  state.lastSeenAt = Date.now();
  const handler = protocolMethods.has(req.method) ? methods.get(req.method) : undefined;
  // Guard against a programming error where a method is in the protocol
  // allowlist but missing from the handler map.
  if (!handler) {
    sendFrame(state.socket, {
      id: req.id,
      error: {
        code: 'INVALID_INPUT',
        message: `Unknown method: ${req.method}`,
      },
    });
    return;
  }

  if (state.inflightRequests >= MAX_PARALLEL_REQUESTS_PER_CLIENT) {
    sendFrame(state.socket, {
      id: req.id,
      error: { code: 'INTERNAL_ERROR', message: 'Too many parallel requests on this connection' },
    });
    return;
  }

  state.inflightRequests += 1;

  Promise.resolve()
    .then(() => handler(req.params))
    .then((result) => {
      const frame = { id: req.id, ok: true as const, result: result ?? null };
      if (req.method === 'shutdown') {
        // A plain write callback only means the frame reached the OS buffer.
        // Destroying a Windows named pipe immediately afterwards can still
        // discard it before the peer reads it. Half-close the requesting
        // socket with the response and let server.close() wait for the
        // graceful stream to finish.
        state.socket.end(JSON.stringify(frame) + '\n');
        setImmediate(() => void stop('client-request', state.socket));
      } else {
        sendFrame(state.socket, frame);
      }
    })
    .catch((err) => {
      try {
        sendFrame(state.socket, { id: req.id, error: errorFromThrown(err) });
      } catch {
        state.socket.destroy();
      }
    })
    .finally(() => {
      state.inflightRequests -= 1;
    });
}

function onData(state: ClientState, chunk: string): void {
  state.buffer += chunk;
  // Check buffer cap BEFORE the frame loop — a chunk without a newline would
  // never enter the while loop and the in-loop check would never fire, letting
  // the buffer grow without bound. Check here unconditionally (mirrors the
  // client-side pattern in client.ts).
  if (state.buffer.length > MAX_FRAME_CHARS) {
    state.socket.destroy(new Error('Frame buffer exceeded maximum size'));
    return;
  }
  let nl: number;
  while ((nl = state.buffer.indexOf('\n')) !== -1) {
    const line = state.buffer.slice(0, nl);
    state.buffer = state.buffer.slice(nl + 1);
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (
        parsed &&
        typeof parsed === 'object' &&
        typeof parsed.method === 'string' &&
        typeof parsed.id === 'number' &&
        parsed.params !== null &&
        typeof parsed.params === 'object' &&
        !Array.isArray(parsed.params)
      ) {
        processRequest(state, parsed as KanbanRequest);
      } else {
        sendFrame(state.socket, {
          id: typeof parsed?.id === 'number' ? parsed.id : -1,
          error: { code: 'INVALID_INPUT', message: 'Invalid Kanban request frame' },
        });
      }
    } catch {
      sendFrame(state.socket, {
        id: -1,
        error: { code: 'INVALID_INPUT', message: 'Malformed JSON frame' },
      });
    }
  }
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { projectRoot: string } {
  let root = '';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--project-root' && i + 1 < argv.length) {
      root = argv[i + 1] ?? '';
      i++;
    }
  }
  if (!root) throw new Error('kanban project server requires --project-root');
  return { projectRoot: root };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  projectRoot = args.projectRoot;
  endpoint = kanbanProjectServerEndpoint(projectRoot);

  await ensureParentDir();

  subscribeToBoardEvents((ev) => {
    broadcastEvent({ type: 'event', event: ev.event, data: ev.data });
  });

  let readyResolve!: () => void;
  let readyReject!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  server = net.createServer((socket) => {
    void ready.then(
      () => acceptClient(socket),
      () => socket.destroy(),
    );
  });

  const listener = server;

  await new Promise<void>((resolve, reject) => {
    const onListenError = (error: Error): void => reject(error);
    listener.once('error', onListenError);
    listener.listen(endpoint!, () => {
      // Attach the permanent handler BEFORE removing the temporary one,
      // so no error can fall through the gap between .off() and .on().
      listener.on('error', (err: NodeJS.ErrnoException) => {
        if (stopping) return;
        if (err.code === 'EADDRINUSE') {
          process.exit(0);
        }
        process.stderr.write(`kanban project server error: ${err.message}\n`);
        process.exit(1);
      });
      listener.off('error', onListenError);
      resolve();
    });
  });

  try {
    sqliteStorage = await SqliteKanbanStorage.open(projectRoot, (mutation) => {
      emitBoardEvent(
        mutation.type === 'created'
          ? 'board.created'
          : mutation.type === 'deleted'
            ? 'board.deleted'
            : 'board.updated',
        mutation.boardId,
        mutation,
      );
    });
    uninstallStorageBackend = installKanbanStorageBackend(projectRoot, sqliteStorage);
    serverInfo = {
      protocolVersion: KANBAN_PROJECT_SERVER_PROTOCOL_VERSION,
      pid: process.pid,
      projectRoot,
      endpoint,
      storage: 'sqlite',
      databasePath: sqliteStorage.databasePath,
      startedAt: new Date().toISOString(),
    };
    readyResolve();
  } catch (error) {
    readyReject(error);
    await stop('storage-initialization-failed');
    throw error;
  }

  process.stdout.write(`kanban project server listening on ${endpoint}\n`);

  // Arm the idle timer at startup. Previously the only caller was the socket
  // 'close' handler, so a daemon that was spawned but never connected to had
  // `idleTimer === undefined` and lived forever. Every sibling daemon arms it
  // right after listen().
  scheduleIdleStop();

  // Orphan guard: kanban has no client heartbeat and no lease sweep, so a
  // half-open socket would pin `clients.size > 0` and defeat the idle timer.
  // A vanished project root is unambiguous — nothing can ever be served again.
  livenessTimer = setInterval(() => {
    void fsPromises.stat(projectRoot).catch(() => {
      void stop('project-root-removed').then(() => process.exit(0));
    });
  }, ROOT_LIVENESS_CHECK_MS);
  livenessTimer.unref?.();
  leaseTimer = setInterval(() => {
    const cutoff = Date.now() - CLIENT_LEASE_MS;
    for (const state of clients) {
      if (state.lastSeenAt >= cutoff) continue;
      state.socket.destroy(new Error('Kanban client lease expired'));
      clients.delete(state);
    }
    scheduleIdleStop();
  }, CLIENT_LEASE_SWEEP_MS);
  leaseTimer.unref?.();

  process.on('SIGTERM', () => void stop('SIGTERM').then(() => process.exit(0)));
  process.on('SIGINT', () => void stop('SIGINT').then(() => process.exit(0)));
}

function acceptClient(socket: net.Socket): void {
  if (stopping) {
    socket.destroy();
    return;
  }
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = undefined;
  socket.setEncoding('utf8');
  const state: ClientState = {
    socket,
    buffer: '',
    inflightRequests: 0,
    lastSeenAt: Date.now(),
  };
  clients.add(state);
  const hello: KanbanHelloFrame = { type: 'hello', ...serverInfo! };
  sendFrame(socket, hello);
  socket.on('data', (chunk: string) => onData(state, chunk));
  socket.on('close', () => {
    clients.delete(state);
    scheduleIdleStop();
  });
  socket.on('error', () => {
    clients.delete(state);
    scheduleIdleStop();
  });
}

/**
 * `file://${process.argv[1]}` never matches `import.meta.url` on Windows —
 * argv[1] is a backslash path (`D:\...\project-server.js`) while import.meta.url
 * is a percent-encoded forward-slash URL (`file:///D:/.../project-server.js`).
 * The daemon therefore silently did nothing and exited 0 when spawned there.
 * `pathToFileURL` is the portable comparison.
 */
const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`kanban project server fatal: ${err?.message ?? err}\n`);
    process.exit(1);
  });
}

// Exported for testing
export { MAX_FRAME_CHARS, onData };
