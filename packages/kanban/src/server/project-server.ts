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
import {
  atomicWrite,
  bindProjectEndpoint,
  createProjectMetadataReasserter,
  isStandaloneBinary,
  type ProjectMetadataReasserter,
  restrictFilePermissions,
} from '@wrongstack/persistence';
import { timingSafeTokenEqual, WRONGSTACK_RUNTIME_VERSION } from '@wrongstack/primitives';
import { KANBAN_DOMAIN_OPERATIONS } from '../domain-operations.js';
import * as kanban from '../manager.js';
import { installKanbanStorageBackend } from '../storage-backend.js';
import { kanbanProjectServerEndpoint } from './endpoint.js';
import { emitBoardEvent, subscribeToBoardEvents } from './event-emitter.js';
import type { ClientState, KanbanSignalGuard } from './project-server-frames.js';
import { sendFrame, writeFrame } from './project-server-frames.js';
import { type Handler, registerStorageMethods } from './project-server-storage-methods.js';
import { errorFromThrown, invalid, parseArgs } from './project-server-validation.js';
import {
  decodeKanbanDomainValue,
  encodeKanbanDomainValue,
  KANBAN_PROJECT_SERVER_METADATA_FILE,
  KANBAN_PROJECT_SERVER_PROTOCOL_VERSION,
  KANBAN_SERVER_METHODS,
  type KanbanHelloFrame,
  type KanbanProjectServerInfo,
  type KanbanProjectServerMetadata,
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

let projectRoot = '';
let endpoint = '';
let serverInfo: KanbanProjectServerInfo | null = null;
const SIGNAL_GUARD: unique symbol = Symbol.for('wrongstack.kanban.project-server.signalGuard');
let signalGuard: KanbanSignalGuard | undefined;

function armSignalHandlers(stopAndExit: (reason: string) => void): KanbanSignalGuard {
  const store = globalThis as typeof globalThis & {
    [SIGNAL_GUARD]?: KanbanSignalGuard | undefined;
  };
  let guard = store[SIGNAL_GUARD];
  if (!guard) {
    let stopTerm: () => void = () => undefined;
    let stopInt: () => void = () => undefined;
    const sigtermHandler = (): void => stopTerm();
    const sigintHandler = (): void => stopInt();
    process.on('SIGTERM', sigtermHandler);
    process.on('SIGINT', sigintHandler);
    guard = {
      retarget(term, int) {
        stopTerm = term;
        stopInt = int;
      },
      detach() {
        process.removeListener('SIGTERM', sigtermHandler);
        process.removeListener('SIGINT', sigintHandler);
        store[SIGNAL_GUARD] = undefined;
      },
    };
    store[SIGNAL_GUARD] = guard;
  }
  guard.retarget(
    () => stopAndExit('SIGTERM'),
    () => stopAndExit('SIGINT'),
  );
  return guard;
}

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

// A daemon of another release can own a different endpoint for this project
// and still write the same metadata file; a refused token puts ours back.
// Created once the endpoint is known (after the bind).
let metadataGuard: ProjectMetadataReasserter | undefined;

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

/**
 * Arm the idle shutdown, but NEVER re-arm an already-armed timer.
 *
 * The `idleTimer` guard is load-bearing. `leaseTimer` (and the other periodic
 * callers below) invoke this every `CLIENT_LEASE_SWEEP_MS` — 15 seconds —
 * while `DEFAULT_IDLE_MS` is five minutes. A `clearTimeout` + re-arm here
 * therefore reset the countdown every sweep and the idle stop could never
 * fire: with zero clients the daemon lived forever, and the LONGER the
 * configured idle window the more certainly it starved.
 *
 * Measured before the fix (no client): idle=5s exited at 5147ms, idle=25s was
 * still alive after 50s. The suite missed it because its servers run with an
 * idle far below the sweep interval, which is the only regime where a
 * re-arming implementation still works.
 *
 * Not re-arming is safe because the timer only exists while `clients.size`
 * is 0, and a connecting client clears it.
 */
function scheduleIdleStop(): void {
  if (stopping || clients.size > 0 || idleTimer) return;
  const idleInput = Number(process.env['WRONGSTACK_KANBAN_SERVER_IDLE_MS']);
  // Node clamps a timer delay above 2^31-1 ms to 1 ms: a huge "never idle out"
  // value would stop the daemon at once.
  const idleMs =
    Number.isFinite(idleInput) && idleInput >= 100
      ? Math.min(idleInput, 2_147_483_647)
      : DEFAULT_IDLE_MS;
  idleTimer = setTimeout(() => stopAndExit('idle-timeout'), idleMs);
  idleTimer.unref?.();
}

async function stop(_reason: string, gracefulSocket?: net.Socket): Promise<void> {
  if (stopping) return;
  stopping = true;
  await metadataGuard?.disable();
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = undefined;
  if (livenessTimer) clearInterval(livenessTimer);
  livenessTimer = undefined;
  if (leaseTimer) clearInterval(leaseTimer);
  leaseTimer = undefined;
  if (signalGuard) {
    signalGuard.detach();
    signalGuard = undefined;
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

const methods = new Map<string, Handler>();
const protocolMethods = new Set<string>(KANBAN_SERVER_METHODS);

function defineMethod(name: string, handler: Handler): void {
  methods.set(name, handler);
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
registerStorageMethods(defineMethod, ownerStorage);

function sumActive(): number {
  let total = 0;
  for (const state of clients) total += state.inflightRequests;
  return total;
}

// ─── Per-client request loop ─────────────────────────────────────────────────

function processRequest(state: ClientState, req: KanbanRequest): void {
  state.lastSeenAt = Date.now();
  // WS-027: prove you could read the owner-only metadata file before acting.
  // WS-SEC-LOW: `!==` on a secret returns at the first differing byte, so
  // its timing leaks the shared-prefix length. Every other credential
  // surface in the repo already compares in constant time; these four IPC
  // daemons were the ones that did not.
  if (!timingSafeTokenEqual(req.authToken, authToken)) {
    void metadataGuard?.reassert();
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
      runtimeVersion: WRONGSTACK_RUNTIME_VERSION,
      protocolVersion: KANBAN_PROJECT_SERVER_PROTOCOL_VERSION,
      pid: process.pid,
      projectRoot,
      endpoint,
      storage: 'sqlite',
      databasePath: sqliteStorage.databasePath,
      startedAt: new Date().toISOString(),
    };
    await writeServerMetadata();
    metadataGuard = createProjectMetadataReasserter({
      metadataPath: serverMetadataPath(projectRoot),
      endpoint,
      pid: process.pid,
      write: writeServerMetadata,
    });
    metadataGuard.enable();
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

  signalGuard?.detach();
  signalGuard = armSignalHandlers(stopAndExit);
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
 * `pathToFileURL` is the portable comparison. The standalone binary shares one
 * URL across every module and calls `main()` through its daemon dispatch.
 */
const isMain =
  process.argv[1] && !isStandaloneBinary()
    ? import.meta.url === pathToFileURL(process.argv[1]).href
    : false;
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`kanban project server fatal: ${err?.message ?? err}\n`);
    process.exit(1);
  });
}

/**
 * Stop WITHOUT exiting — for a host that runs `main()` inside its own process
 * (the in-process lifecycle harness). A daemon left running there keeps its
 * 5-minute idle timer armed, and when that fires `stopAndExit()` kills the
 * host. Every daemon-owned stop path still goes through `stopAndExit()`.
 */
export function stopInProcess(reason = 'in-process-stop'): Promise<void> {
  return stop(reason);
}

// Exported for testing
export { MAX_FRAME_CHARS, onData };
