#!/usr/bin/env node
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import * as fsPromises from 'node:fs/promises';
import * as net from 'node:net';
import * as path from 'node:path';
import { EventBus } from '@wrongstack/contracts/kernel';
import { restrictFilePermissions } from '@wrongstack/core/security';
import {
  atomicWrite,
  canonicalProjectRoot,
  startSharedHeapWatchdog,
  useDaemonPerfDefaults,
} from '@wrongstack/core/utils';
import { bindProjectEndpoint, createProjectMetadataReasserter } from '@wrongstack/persistence';
import { WRONGSTACK_RUNTIME_VERSION } from '@wrongstack/primitives';
import { SqliteMemoryPort } from './memory-port.js';
import { detectNinepStoreMount, ninepStoreRefusalMessage, readSelfMounts } from './mount-probe.js';
import { dispatch as dispatchSageOperation } from './project-server-dispatch.js';
import {
  resolveProjectSageStorageRoot,
  sageProjectServerEndpoint,
  sageProjectServerMetadataPath,
} from './project-server-endpoint.js';
import { createHygieneRunner, maintenanceDoctorCheck } from './project-server-hygiene.js';
import { importLegacyFilesIntoStore } from './project-server-legacy-import.js';
import {
  armProjectServerSignalGuard,
  drainAndDisposeAfterStop,
  endClientsForShutdown,
} from './project-server-lifecycle.js';
import { type ClientState, type CompleteSageStore, parseArgs } from './project-server-options.js';
import {
  SAGE_PROJECT_SERVER_PROTOCOL_VERSION,
  type SageProjectServerClientMessage,
  type SageProjectServerInfo,
  type SageProjectServerMetadata,
  type SageRequestMetadata,
  type SageServerOperationName,
  type SageServerOperations,
} from './project-server-protocol.js';
import { createSlowOperationReporter } from './project-server-slow-ops.js';
import {
  answerWhenSettled,
  authorizeClientMessage,
  broadcastMemoryEvent,
  consumeClientFrames,
  send,
} from './project-server-wire.js';

const DEFAULT_IDLE_MS = 5 * 60_000;
/** Reports a dispatch that blocked the event loop (see project-server-slow-ops.ts). */
const reportSlowOperation = createSlowOperationReporter(() => ({
  pendingRequests,
  clients: clients.size,
}));

// Long-lived daemon: lean SQLite residency unless the operator says
// otherwise. Must run before any store opens.
useDaemonPerfDefaults();

const parsed = parseArgs(process.argv.slice(2));
const projectRoot = canonicalProjectRoot(parsed.projectRoot);
const storageRoot = resolveProjectSageStorageRoot(projectRoot, parsed.directory);
const endpoint = sageProjectServerEndpoint(projectRoot, parsed.directory);
const metadataPath = sageProjectServerMetadataPath(projectRoot, parsed.directory);
// Fail fast BEFORE the bind election: a WAL store on a 9p/drvfs mount (a
// Windows drive reached through WSL's /mnt/*) cannot open SQLite's
// shared-memory WAL index (SQLITE_IOERR_SHMOPEN), and the historical failure
// shape was the worst possible one — the daemon bound the endpoint, then died
// in store init, leaving a tombstone socket the client retried against for
// the full 10s window while every respawned daemon crashed identically with
// its stderr discarded. Refusing pre-bind makes it one clean message.
// `process.exit` (not `process.exitCode`) because the module body must stop
// here — nothing below this point may run for a refused store.
const ninepMountFsType = detectNinepStoreMount(storageRoot, readSelfMounts());
if (ninepMountFsType) {
  process.stderr.write(`${ninepStoreRefusalMessage(storageRoot, ninepMountFsType)}\n`);
  process.exit(1);
}
const idleMsInput = Number(process.env['WRONGSTACK_SAGE_SERVER_IDLE_MS']);
// Node clamps a timer delay above 2^31-1 ms to 1 ms: a huge "never idle out"
// value would stop the daemon at once.
const idleMs =
  Number.isFinite(idleMsInput) && idleMsInput >= 100
    ? Math.min(idleMsInput, 2_147_483_647)
    : DEFAULT_IDLE_MS;
/**
 * A socket that connects and then never sends a single byte pins this daemon
 * open forever: `clients.add` happens on accept, so `clients.size` stays above
 * zero, `scheduleIdleStop()` returns early and the idle timer is never armed.
 * No auth token is needed — the socket is registered before any message is
 * validated. Measured before this existed: with a 2s idle window a silent
 * connection kept the daemon alive past 15s.
 *
 * Safe here even though `broadcast()` writes to every connected socket with no
 * subscription filter, because the reap keys off "has this socket EVER
 * spoken". The only consumer of SAGE events in the repo is
 * `remote-memory-port.ts`, and it speaks: `connection.call(op, args, …)`.
 * `onEvent()` itself is purely local — it appends to a listener Set and sends
 * nothing — so subscribing never makes a socket look alive, and there is no
 * listen-only mode on the port.
 *
 * NOTE: that unfiltered broadcast is a SEPARATE finding — events still reach
 * any socket that sends anything at all, authenticated or not. Closing that is
 * an authorization change and is deliberately not bundled here.
 *
 * The sweep deliberately does NOT call `scheduleIdleStop()` — doing that from
 * a periodic timer is the re-arm starvation that kept the mailbox and kanban
 * daemons alive forever. `destroy()` fires `close`, which owns the bookkeeping.
 */
const DEFAULT_SILENT_CLIENT_MS = 120_000;
const silentInput = Number(process.env['WRONGSTACK_SAGE_SERVER_SILENT_CLIENT_MS']);
const silentClientMs =
  Number.isFinite(silentInput) && silentInput >= 1_000 ? silentInput : DEFAULT_SILENT_CLIENT_MS;
const silentSweepMs = Math.min(30_000, Math.max(1_000, Math.floor(silentClientMs / 4)));
const startedAt = new Date().toISOString();
// Per-process auth token. Minted at startup, persisted to `server.json`,
// required on every `request` message — closes the "same-UID process can
// invoke any op" trust boundary that the 0o600 socket alone does not
// close (the socket only restricts non-root cross-UID processes).
const authToken = randomBytes(16).toString('hex');
const requestContext = new AsyncLocalStorage<SageRequestMetadata>();
const events = new EventBus();
const store = new SqliteMemoryPort({
  projectRoot,
  directory: parsed.directory,
  events,
  operationContext: () => requestContext.getStore(),
}) as CompleteSageStore;
const hygiene = createHygieneRunner(store, {
  statePath: path.join(storageRoot, 'hygiene', 'maintenance.json'),
  // Maintenance holds the single daemon thread for seconds on a large store;
  // it waits for a moment with no request in flight.
  isBusy: () => pendingRequests > 0,
  log: logDaemon,
  afterMaintenance: () => selfHealAfterMaintenance(),
});

function logDaemon(message: string): void {
  process.stderr.write(`${new Date().toISOString()} ${message}
`);
}

/**
 * Graph and index repairs that are safe to apply unattended: they never touch
 * a memory's text, status or existence, only derived structure. Applying them
 * after every maintenance pass is what keeps hub noise, dangling edges and
 * runtime-mode audiences from accumulating again between doctor runs.
 */
const SELF_HEAL_FIXES = new Set([
  'graph-hubs',
  'dangling-edges',
  'audience-runtime-mode',
  'fts-rebuild',
]);

async function selfHealAfterMaintenance(): Promise<void> {
  const report = await store.doctor();
  const fix = report.checks
    .filter((check) => check.severity !== 'ok' && check.fix && SELF_HEAL_FIXES.has(check.fix))
    .map((check) => check.fix!)
    .filter((value, index, all) => all.indexOf(value) === index);
  const healed = fix.length > 0 ? await store.doctor({ fix }) : report;
  for (const applied of healed.fixesApplied ?? []) {
    logDaemon(`sage doctor: self-healed ${applied.fix}: ${applied.detail}`);
  }
  for (const check of healed.checks) {
    if (check.severity === 'warn' || check.severity === 'error') {
      logDaemon(`sage doctor: ${check.severity} ${check.id}: ${check.summary}`);
    }
  }
}
const clients = new Set<ClientState>();
let pendingRequests = 0;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let silentClientSweep: ReturnType<typeof setInterval> | undefined;
let stopping = false;
/**
 * Dispatches that started but have not produced a response yet. Two consumers:
 * `stop()` answers every still-unsettled request with a clean stopping
 * rejection before its socket is destroyed, and drains this set (bounded)
 * before `store.dispose()` so SQLite is not closed under a running operation.
 */
const activeDispatches = new Set<Promise<unknown>>();
/**
 * Bounded force-destroy for the graceful end() close in `stop()`: a client
 * that stops reading must not hold shutdown open past this window.
 */
const SAGE_FORCE_DESTROY_MS = 500;
function activeClientRequests(): number {
  let total = 0;
  for (const client of clients) total += client.active.size;
  return total;
}
const stopMemoryWatchdog = startSharedHeapWatchdog({
  collectStats: () => ({
    surface: 'sage-project-server',
    clients: clients.size,
    pendingRequests,
    activeRequests: activeClientRequests(),
    automaticHygieneInFlight: hygiene.automaticInFlight(),
  }),
});

const serverInfo: SageProjectServerInfo = {
  runtimeVersion: WRONGSTACK_RUNTIME_VERSION,
  protocolVersion: SAGE_PROJECT_SERVER_PROTOCOL_VERSION,
  pid: process.pid,
  projectRoot,
  storageRoot,
  endpoint,
  startedAt,
};

/**
 * What `server.json` holds — `serverInfo` plus the secret. WS-028: the token
 * used to be part of `serverInfo` itself, which is the `hello` payload sent to
 * every socket that connects, so the daemon handed its own credential to the
 * caller the credential was meant to refuse.
 */
const serverMetadata: SageProjectServerMetadata = { ...serverInfo, authToken };

// A daemon of another release can own a different endpoint for this project
// and still write the same `server.json`; a refused token puts ours back.
const metadataGuard = createProjectMetadataReasserter({
  metadataPath,
  endpoint,
  pid: process.pid,
  write: writeMetadata,
});

let resolveReady: (() => void) | undefined;
let rejectReady: ((error: unknown) => void) | undefined;
const ready = new Promise<void>((resolve, reject) => {
  resolveReady = resolve;
  rejectReady = reject;
});

events.onPattern('memory.*', (event, payload) => {
  broadcastMemoryEvent(clients, event, payload, requestContext.getStore());
});

async function serverStatus(): Promise<SageServerOperations['ping']['result']> {
  await ready;
  return {
    ...serverInfo,
    clients: clients.size,
    pendingRequests,
    health: await store.health(),
  };
}

async function dispatch(
  op: SageServerOperationName,
  rawArgs: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  return dispatchSageOperation(
    {
      store,
      ready,
      serverStatus,
      runHygiene: (args) => hygiene.run(args),
      importLegacyFiles: (files) => importLegacyFilesIntoStore(projectRoot, store, files),
      maintenance: (args) =>
        args.action === 'schedule' ? hygiene.schedule(args.options) : hygiene.status(),
      doctor: (args) => runDaemonDoctor(args.options),
    },
    op,
    rawArgs,
    signal,
  );
}

/**
 * The store measures itself; the daemon adds what only it knows (the
 * maintenance scheduler) and routes the `hygiene` repair through the runner so
 * a doctor-triggered pass is recorded like a scheduled one.
 */
async function runDaemonDoctor(
  options: SageServerOperations['doctor']['args']['options'],
): Promise<SageServerOperations['doctor']['result']> {
  const fixes = options?.fix ?? [];
  const applied: NonNullable<SageServerOperations['doctor']['result']['fixesApplied']> = [];
  if (fixes.includes('hygiene')) {
    const report = await hygiene.runNow(options?.hygieneOptions);
    applied.push({
      fix: 'hygiene',
      changed: report.deleted + report.staled + report.superseded + report.reviewCandidatesCreated,
      detail: `hygiene: ${report.deleted} expired removed, ${report.staled} staled, ${report.superseded} superseded, ${report.reviewCandidatesCreated} review candidates`,
    });
  }
  const report = await store.doctor({
    ...options,
    fix: fixes.filter((fix) => fix !== 'hygiene'),
  });
  const maintenance = hygiene.status();
  return {
    ...report,
    maintenance,
    checks: [maintenanceDoctorCheck(maintenance, Date.now()), ...report.checks],
    ...(applied.length > 0 || report.fixesApplied
      ? { fixesApplied: [...applied, ...(report.fixesApplied ?? [])] }
      : {}),
  };
}

function checkAuthToken(state: ClientState, message: SageProjectServerClientMessage): boolean {
  return authorizeClientMessage(state, message, authToken, () => void metadataGuard.reassert());
}

function handleMessage(state: ClientState, message: SageProjectServerClientMessage): void {
  // Auth gate FIRST — every `request` message (the only message type
  // that mutates SAGE state and that carries an `authToken` slot in
  // its `meta`) is rejected if the token does not match the
  // per-process `authToken` minted at startup, which a caller can only
  // learn by reading the owner-only `server.json`. `shutdown` carries the
  // token too (WS-028) because stopping the daemon affects every client.
  // `cancel` is ungated: it reaches only the sending connection's own
  // in-flight requests, so there is nothing to escalate.
  if (!checkAuthToken(state, message)) return;

  if (message.type === 'cancel') {
    state.active.get(message.id)?.abort(new Error('SAGE request cancelled by client'));
    return;
  }
  if (message.type === 'shutdown') {
    send(state, { type: 'response', id: message.id, ok: true, result: { stopping: true } });
    setImmediate(() => void stop(message.reason ?? 'client-request'));
    return;
  }

  const controller = new AbortController();
  state.active.set(message.id, controller);
  pendingRequests++;
  // Server-assigned `clientId` overrides any client-supplied value. The
  // rest of the meta is forwarded as-is for `sessionId`/`traceId`, which
  // are treated as opaque correlators by the audit log. `authToken` is
  // intentionally NOT forwarded — it stays a server-only secret.
  const safeMeta: SageRequestMetadata = {
    clientId: state.clientId,
    ...(message.meta.sessionId !== undefined ? { sessionId: message.meta.sessionId } : {}),
    ...(message.meta.traceId !== undefined ? { traceId: message.meta.traceId } : {}),
  };
  const startedAt = Date.now();
  state.unsettled.add(message.id);
  const tracked = answerWhenSettled(
    state,
    message.id,
    requestContext.run(safeMeta, () => dispatch(message.op, message.args, controller.signal)),
  );
  activeDispatches.add(tracked);
  void tracked.finally(() => {
    state.active.delete(message.id);
    pendingRequests = Math.max(0, pendingRequests - 1);
    reportSlowOperation(message.op, Date.now() - startedAt);
    activeDispatches.delete(tracked);
  });
}

function scheduleIdleStop(): void {
  if (stopping || clients.size > 0) return;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => void stop('idle-timeout'), idleMs);
  idleTimer.unref?.();
}

async function writeMetadata(): Promise<void> {
  await fsPromises.mkdir(path.dirname(metadataPath), { recursive: true });
  // `serverMetadata`, not `serverInfo`: the token lives ONLY in this
  // owner-only file now, never on the wire (WS-028).
  //
  // WS-059: was a hand-rolled write + rename with an `rm(metadataPath)`
  // fallback. On Windows the rename fails whenever a reader holds the
  // destination, so that fallback was the common path — and between the `rm`
  // and the retry `rename` the file does not exist. A client reading in that
  // window concludes there is no daemon and spawns a second one, breaking the
  // one-daemon-per-project invariant. `atomicWrite` replaces in place with a
  // bounded rename retry and never unlinks the destination first.
  await atomicWrite(metadataPath, `${JSON.stringify(serverMetadata, null, 2)}\n`, {
    mode: 0o600,
  });
  // `mode: 0o600` is honored on POSIX but ignored by Node on Windows, where
  // the file inherits the parent directory's ACLs instead — and the IPC
  // endpoint excludes nobody on Windows either, so a readable metadata file
  // hands this daemon's per-process token to any local account. That matters
  // more here than anywhere: WS-028 was this daemon handing its credential to
  // the caller it meant to refuse. Strips inherited ACEs, grants the owner
  // alone.
  await restrictFilePermissions(metadataPath, {
    label: 'sage-server-metadata',
    warn: (message) => process.stderr.write(`${message}\n`),
  });
}

async function removeOwnedMetadata(): Promise<void> {
  try {
    const current = JSON.parse(await fsPromises.readFile(metadataPath, 'utf8')) as {
      pid?: number;
    };
    if (current.pid === process.pid) await fsPromises.rm(metadataPath, { force: true });
  } catch {
    // Missing or replaced metadata belongs to no cleanup action here.
  }
}

async function stop(_reason: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  metadataGuard.disable();
  if (idleTimer) clearTimeout(idleTimer);
  hygiene.dispose();
  if (silentClientSweep) clearInterval(silentClientSweep);
  silentClientSweep = undefined;
  idleTimer = undefined;
  // WS-059: remove metadata BEFORE releasing the endpoint. The bind is the
  // ownership election, so while it is still held no successor daemon can
  // exist — and therefore none can have its metadata deleted by the
  // read-then-delete pid compare in `removeOwnedMetadata`.
  await removeOwnedMetadata();
  // End client sockets BEFORE awaiting close(): net.Server.close() only
  // fires its callback once every connection has ended, so awaiting it with
  // live clients deadlocked this function forever — and with the metadata
  // already removed above, the zombie kept the endpoint bound while
  // server.json was gone. A successor's EADDRINUSE probe then got an answer
  // from the zombie, concluded "healthy owner", and exited: SAGE permanently
  // dead for the project. The kanban daemon
  // (packages/kanban/src/server/project-server.ts) is the reference
  // ordering, including the bounded close for Windows named-pipe handles
  // the kernel can retain.
  const closing = [...clients];
  endClientsForShutdown(closing);
  clients.clear();
  await new Promise<void>((resolve) => {
    server.close(() => {
      clearTimeout(forceDestroyTimer);
      resolve();
    });
    // Bounded force-destroy for the graceful close, mirroring the
    // session-catalog/kanban/mailbox graceful-close pattern.
    const forceDestroyTimer = setTimeout(() => {
      for (const state of closing) state.socket.destroy();
      resolve();
    }, SAGE_FORCE_DESTROY_MS);
    forceDestroyTimer.unref?.();
  });
  await drainAndDisposeAfterStop({ activeDispatches, store, endpoint, stopMemoryWatchdog });
}

const server = net.createServer((socket) => {
  if (stopping) {
    socket.destroy();
    return;
  }
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = undefined;
  socket.setEncoding('utf8');
  // Server-assigned nonce. Pairs with `pid`+`endpoint` so audit log
  // entries are correlatable to a specific connection without trusting
  // any value the client supplied.
  const clientId = `sage-${process.pid}-${randomBytes(8).toString('hex')}`;
  const state: ClientState = {
    socket,
    buffer: '',
    active: new Map(),
    connectedAt: Date.now(),
    spoken: false,
    authenticated: false,
    unsettled: new Set<number>(),
    clientId,
  };
  clients.add(state);
  send(state, { type: 'hello', ...serverInfo });
  socket.on('data', (chunk: string) => consumeClientFrames(state, chunk, handleMessage));
  socket.on('close', () => {
    for (const controller of state.active.values()) {
      controller.abort(new Error('SAGE client disconnected'));
    }
    clients.delete(state);
    scheduleIdleStop();
  });
  socket.on('error', () => {
    // Error already handled by 'close' cleanup above.  Must have a
    // listener or Node.js 15+ throws on 'error' events with no handler.
    // This is consistent with the kanban and codebase-index servers.
  });
});

// See `silentClientMs`: drops only sockets that connected and never sent a
// byte, so the idle shutdown can actually be reached. `close` does the rest.
silentClientSweep = setInterval(() => {
  const cutoff = Date.now() - silentClientMs;
  for (const state of clients) {
    if (!state.spoken && state.connectedAt < cutoff) {
      state.socket.destroy(new Error('SAGE client connected without ever sending a request'));
    }
  }
}, silentSweepMs);
silentClientSweep.unref?.();

// The bind is the ownership election, including the probe-then-reclaim ladder
// for an endpoint left behind by a daemon that died without cleanup. That
// ladder used to live here as a hand-rolled copy; it is now the shared
// `bindProjectEndpoint` primitive so every project daemon recovers the same
// way and none can be shipped without it.
void (async () => {
  const bind = await bindProjectEndpoint({ server, endpoint, service: 'sage' });
  if (bind.outcome === 'already-owned') {
    // A live daemon owns the project. Exit clean without touching the store —
    // a second writer over the same SAGE database is the failure this election
    // exists to prevent.
    process.exitCode = 0;
    return;
  }
  if (bind.outcome === 'failed') {
    rejectReady?.(bind.error);
    process.stderr.write(`sage project server failed: ${bind.error.message}\n`);
    process.exitCode = 1;
    return;
  }
  if (bind.reclaimedStaleEndpoint) {
    process.stderr.write(`sage project server reclaimed stale endpoint ${endpoint}\n`);
  }
  server.on('error', (error: NodeJS.ErrnoException) => {
    if (stopping) return;
    rejectReady?.(error);
    process.stderr.write(`sage project server error: ${error.message}\n`);
    process.exitCode = 1;
  });
  try {
    await store.initialize();
    await writeMetadata();
    metadataGuard.enable();
    resolveReady?.();
    scheduleIdleStop();
  } catch (error) {
    rejectReady?.(error);
    await stop('initialization-failed').catch(() => {});
    process.exitCode = 1;
  }
})();

// One SIGINT/SIGTERM pair per PROCESS (see armProjectServerSignalGuard).
armProjectServerSignalGuard(stop);
