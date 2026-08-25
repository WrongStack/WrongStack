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
import { randomBytes } from 'node:crypto';
import * as fsPromises from 'node:fs/promises';
import * as net from 'node:net';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { atomicWrite, bindProjectEndpoint, restrictFilePermissions } from '@wrongstack/persistence';
import { KANBAN_DOMAIN_OPERATIONS } from '../domain-operations.js';
import { StaleWriteError } from '../manager/lifecycle-error.js';
import * as kanban from '../manager.js';
import { installKanbanStorageBackend } from '../storage-backend.js';
import type { KanbanBoard, KanbanBoardHistoryEntry, KanbanEvent } from '../types.js';
import { kanbanProjectServerEndpoint } from './endpoint.js';
import { emitBoardEvent, subscribeToBoardEvents } from './event-emitter.js';
import {
  decodeKanbanDomainValue,
  encodeKanbanDomainValue,
  KANBAN_PROJECT_SERVER_METADATA_FILE,
  KANBAN_PROJECT_SERVER_PROTOCOL_VERSION,
  KANBAN_SERVER_METHODS,
  type KanbanErrorCode,
  type KanbanErrorResponse,
  type KanbanHelloFrame,
  type KanbanProjectServerInfo,
  type KanbanProjectServerMetadata,
  type KanbanRequest,
  type KanbanServerEvent,
  type KanbanWorkflowCommand,
  type KanbanWorkflowState,
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
let sigtermHandler: (() => void) | undefined;
let sigintHandler: (() => void) | undefined;

/**
 * Per-process auth token. WS-027: this daemon owns every board in the project
 * and drives the workflow command queue, and it admitted anything that could
 * open the socket. The 0700 socket directory only excludes OTHER users, and on
 * Windows named pipes it does not even do that, so "same-UID process" was the
 * whole boundary. A caller must now prove it could read the daemon's
 * owner-only `server.json` before it may act.
 *
 * Deliberately NOT part of `serverInfo`: that object is the `hello` payload
 * sent to every socket that connects, which is exactly how the SAGE daemon
 * handed its own credential to the caller it meant to refuse (WS-028).
 */
const authToken = randomBytes(16).toString('hex');

/**
 * Resolves once `server.json` is on disk. The endpoint bind is the ownership
 * election, so metadata cannot be written before listening — which would leave
 * a window where the socket accepts connections and no client can know the
 * token. The daemon holds `hello` until the file exists instead: `hello` means
 * ready, and the client's connect already waits for it.
 */
let markMetadataWritten: (() => void) | undefined;
const metadataWritten = new Promise<void>((resolve) => {
  markMetadataWritten = resolve;
});

/**
 * `<projectRoot>/.wrongstack/kanban-server.json`, NOT inside the kanbans
 * directory: `sqlite-project-server.test.ts` asserts that directory contains
 * no `.json` entries, which is how the completed migration off the legacy JSON
 * board store is pinned. Dropping a server file in there would quietly weaken
 * that invariant to buy nothing.
 */
function serverMetadataPath(root: string): string {
  return path.join(root, '.wrongstack', KANBAN_PROJECT_SERVER_METADATA_FILE);
}

async function writeServerMetadata(): Promise<void> {
  if (!serverInfo) return;
  const target = serverMetadataPath(projectRoot);
  const metadata: KanbanProjectServerMetadata = { ...serverInfo, authToken };
  await fsPromises.mkdir(path.dirname(target), { recursive: true });
  // WS-059: this was a hand-rolled write + rename with an `rm(target)`
  // fallback. On Windows the rename fails whenever a reader holds the
  // destination, so the rm branch was not an edge case — it was the common
  // path. Between the `rm` and the retry `rename` the metadata file does not
  // exist, and a client that reads it in that window concludes there is no
  // daemon and spawns a second one, breaking the one-daemon-per-project
  // invariant this file exists to hold.
  //
  // `atomicWrite` replaces in place with a bounded rename retry over the
  // transient Windows codes and never unlinks the destination first, so the
  // file is present at every instant. The mailbox, chronicle and SAGE daemons
  // were all moved onto it for exactly this reason; this one was missed.
  await atomicWrite(target, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
  // `mode: 0o600` is honored on POSIX but ignored by Node on Windows, where
  // the file inherits the parent directory's ACLs instead — and the IPC
  // endpoint excludes nobody on Windows either, so a readable metadata file
  // hands this daemon's per-process token to any local account. Strips
  // inherited ACEs and grants the owner alone.
  await restrictFilePermissions(target, {
    label: 'kanban-server-metadata',
    warn: (message: string) => process.stderr.write(`${message}\n`),
  });
}
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

/**
 * Ensures the daemon exits (code 0) after stop(), regardless of whether stop()
 * resolves, rejects, or hangs. Every exit path MUST go through this — relying
 * on natural process exit leaves a zombie when a ref'd handle (half-closed
 * socket, lingering SQLite descriptor) survives cleanup.
 *
 * The 2s hangGuard is intentionally NOT unref'd: if stop() wedges and removes
 * every other handle, the ref'd guard keeps the loop alive so it can still
 * fire and force exit. stop() is internally bounded (server.close has a 500ms
 * fallback), so the 2s cap only fires on a genuine wedge.
 */
function stopAndExit(reason: string, gracefulSocket?: net.Socket): void {
  const exit = () => process.exit(0);
  const hangGuard = setTimeout(exit, 2_000);
  void stop(reason, gracefulSocket)
    .catch(() => {})
    .finally(() => {
      clearTimeout(hangGuard);
      exit();
    });
}

function scheduleIdleStop(): void {
  if (stopping || clients.size > 0) return;
  if (idleTimer) clearTimeout(idleTimer);
  const idleInput = Number(process.env['WRONGSTACK_KANBAN_SERVER_IDLE_MS']);
  const idleMs = Number.isFinite(idleInput) && idleInput >= 100 ? idleInput : DEFAULT_IDLE_MS;
  idleTimer = setTimeout(() => stopAndExit('idle-timeout'), idleMs);
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
  if (sigtermHandler) {
    process.removeListener('SIGTERM', sigtermHandler);
    sigtermHandler = undefined;
  }
  if (sigintHandler) {
    process.removeListener('SIGINT', sigintHandler);
    sigintHandler = undefined;
  }
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
  //
  // On Windows named pipes, server.close() can hang indefinitely when the
  // kernel retains a reference to the pipe handle. The 500 ms hard fallback
  // (matching packages/tools codebase-index project-server) ensures stop()
  // resolves within bounded time so the process can exit.
  if (server) {
    const listener = server;
    server = null;
    await new Promise<void>((resolve) => {
      listener.close(() => {
        clearTimeout(timer);
        resolve();
      });
      const timer = setTimeout(() => {
        resolve();
      }, 500);
      timer.unref?.();
    });
  }
  if (process.platform !== 'win32' && endpoint) {
    await fsPromises.rm(endpoint, { force: true }).catch(() => {});
  }
  uninstallStorageBackend?.();
  uninstallStorageBackend = null;
  sqliteStorage?.close();
  sqliteStorage = null;
}

// ─── Method registrations ────────────────────────────────────────────────────
//
// All handlers are async to give the call site a uniform shape. The `direct`
// wrapper strips the `Promise` so we can access `.id` and other properties
// on the resolved value.

// biome-ignore lint/suspicious/noExplicitAny: JSON wire params of method-specific shape — handlers narrow per method.
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
defineMethod('workflowReadState', async ({ workflowId }: { workflowId: string }) => {
  assertWorkflowId(workflowId);
  return ownerStorage().readWorkflowState(workflowId);
});
defineMethod(
  'workflowWriteState',
  async ({
    workflowId,
    value,
    expectedRevision,
  }: {
    workflowId: string;
    value: unknown;
    expectedRevision?: number;
  }): Promise<KanbanWorkflowState> => {
    assertWorkflowId(workflowId);
    if (value === undefined) invalid('workflowWriteState requires a JSON value');
    if (
      expectedRevision !== undefined &&
      (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
    ) {
      invalid('workflowWriteState expectedRevision must be a non-negative integer');
    }
    const state = await ownerStorage().writeWorkflowState(workflowId, value, expectedRevision);
    emitBoardEvent('workflow.state.updated', workflowId, {
      workflowId,
      revision: state.revision,
    });
    return state;
  },
);
defineMethod(
  'workflowListStates',
  async ({ prefix, limit }: { prefix: string; limit?: number }) => {
    assertWorkflowPrefix(prefix);
    const normalizedLimit = limit === undefined ? 100 : Math.floor(limit);
    if (!Number.isFinite(normalizedLimit) || normalizedLimit < 1 || normalizedLimit > 1_000) {
      invalid('workflowListStates limit must be between 1 and 1000');
    }
    return ownerStorage().listWorkflowStates(prefix, normalizedLimit);
  },
);
defineMethod('workflowDeleteState', async ({ workflowId }: { workflowId: string }) => {
  assertWorkflowId(workflowId);
  const deleted = await ownerStorage().deleteWorkflowState(workflowId);
  if (deleted) emitBoardEvent('workflow.state.deleted', workflowId, { workflowId });
  return deleted;
});
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
defineMethod('storageAppendBoardHistory', async ({ entry }: { entry: KanbanBoardHistoryEntry }) => {
  if (!entry) invalid('storageAppendBoardHistory requires entry');
  await ownerStorage().appendBoardHistory(entry);
  return { appended: true };
});
defineMethod('storageReadBoardHistory', async ({ boardId }: { boardId?: string }) => {
  return ownerStorage().readBoardHistory(boardId);
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
defineMethod(
  'workflowEnqueueCommand',
  async ({ workflowId, command }: { workflowId: string; command: KanbanWorkflowCommand }) => {
    assertWorkflowId(workflowId);
    if (
      !command ||
      command.workflowId !== workflowId ||
      typeof command.id !== 'string' ||
      command.id.length === 0 ||
      command.id.length > 128 ||
      typeof command.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(command.createdAt)) ||
      typeof command.type !== 'string' ||
      command.type.length === 0 ||
      command.type.length > 128
    ) {
      invalid('workflowEnqueueCommand requires a valid command');
    }
    const enqueued = await ownerStorage().enqueueWorkflowCommand(workflowId, command);
    if (enqueued) {
      emitBoardEvent('workflow.command', workflowId, {
        workflowId,
        commandId: command.id,
        type: command.type,
      });
    }
    return { enqueued };
  },
);
defineMethod(
  'workflowDrainCommands',
  async ({ workflowId, limit }: { workflowId: string; limit?: number }) => {
    assertWorkflowId(workflowId);
    const normalizedLimit = limit === undefined ? 100 : Math.floor(limit);
    if (!Number.isFinite(normalizedLimit) || normalizedLimit < 1 || normalizedLimit > 1_000) {
      invalid('workflowDrainCommands limit must be between 1 and 1000');
    }
    return ownerStorage().drainWorkflowCommands(workflowId, normalizedLimit);
  },
);

function assertWorkflowId(workflowId: string): void {
  if (
    typeof workflowId !== 'string' ||
    workflowId.length === 0 ||
    workflowId.length > 256 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(workflowId)
  ) {
    invalid('workflowId must be a safe non-empty project-local identifier');
  }
}

function assertWorkflowPrefix(prefix: string): void {
  if (
    typeof prefix !== 'string' ||
    prefix.length === 0 ||
    prefix.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(prefix)
  ) {
    invalid('workflow prefix must be a safe non-empty project-local prefix');
  }
}

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
  // WS-027: prove you could read the owner-only metadata file before acting.
  if (req.authToken !== authToken) {
    sendFrame(state.socket, {
      id: req.id,
      error: {
        code: 'UNAUTHORIZED',
        message:
          'Kanban IPC request rejected: missing or invalid authToken. ' +
          'Reconnect to refresh metadata (server.json#authToken).',
      },
    });
    return;
  }
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
        setImmediate(() => stopAndExit('client-request', state.socket));
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
  for (;;) {
    const nl = state.buffer.indexOf('\n');
    if (nl === -1) break;
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

  // The bind is the ownership election. `bindProjectEndpoint` also reclaims an
  // endpoint left behind by a daemon that died without cleanup — kanban used
  // to treat that case as a plain EADDRINUSE and exit, which made a single
  // SIGKILL wedge the project's kanban permanently.
  const bind = await bindProjectEndpoint({ server: listener, endpoint, service: 'kanban' });
  if (bind.outcome === 'already-owned') {
    // Lost the race to a live daemon. Clients reach the winner; exit clean and
    // never open a second writer over the same database.
    process.exit(0);
  }
  if (bind.outcome === 'failed') throw bind.error;
  if (bind.reclaimedStaleEndpoint) {
    process.stderr.write(`kanban project server reclaimed stale endpoint ${endpoint}\n`);
  }
  listener.on('error', (err: NodeJS.ErrnoException) => {
    if (stopping) return;
    process.stderr.write(`kanban project server error: ${err.message}\n`);
    process.exit(1);
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
    await writeServerMetadata();
    markMetadataWritten?.();
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
      stopAndExit('project-root-removed');
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

  if (sigtermHandler) process.removeListener('SIGTERM', sigtermHandler);
  if (sigintHandler) process.removeListener('SIGINT', sigintHandler);
  sigtermHandler = () => stopAndExit('SIGTERM');
  sigintHandler = () => stopAndExit('SIGINT');
  process.on('SIGTERM', sigtermHandler);
  process.on('SIGINT', sigintHandler);
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
  // Greet only once the token is readable on disk — see `metadataWritten`.
  void metadataWritten.then(() => {
    if (socket.destroyed || !serverInfo) return;
    const hello: KanbanHelloFrame = { type: 'hello', ...serverInfo };
    sendFrame(socket, hello);
  });
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
