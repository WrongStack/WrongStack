#!/usr/bin/env node

/**
 * One detached mailbox owner per local WrongStack project state directory.
 *
 * Only this process opens the project SQLite database. Every CLI/TUI/WebUI/HQ
 * process talks to it through the deterministic local IPC endpoint.
 */

import { randomBytes } from 'node:crypto';
import * as fsPromises from 'node:fs/promises';
import * as net from 'node:net';
import * as path from 'node:path';
import { EventBus } from '@wrongstack/contracts/kernel/events';
import { bindProjectEndpoint, createProjectMetadataReasserter } from '@wrongstack/persistence';
import { timingSafeTokenEqual, WRONGSTACK_RUNTIME_VERSION } from '@wrongstack/primitives';
import { restrictFilePermissions } from '../security/file-permissions.js';
import { atomicWrite } from '../utils/atomic-write.js';
import { startSharedHeapWatchdog } from '../utils/heap-watchdog.js';
import { useDaemonPerfDefaults } from '../utils/perf-profile.js';
import { MailboxEventEmitter } from './mailbox-events.js';
import {
  mailboxProjectServerEndpoint,
  mailboxProjectServerMetadataPath,
} from './mailbox-project-server-endpoint.js';
import {
  encodeMailboxProjectServerMessage,
  isMailboxProjectServerClientMessage,
  MAILBOX_PROJECT_SERVER_MAX_FRAME_CHARS,
  MAILBOX_PROJECT_SERVER_PROTOCOL_VERSION,
  type MailboxProjectServerClientMessage,
  type MailboxProjectServerInfo,
  type MailboxProjectServerMessage,
  type MailboxProjectServerMetadata,
  type MailboxServerOperationName,
  type MailboxServerOperations,
} from './mailbox-project-server-protocol.js';
import { dispatchMailboxOperation } from './mailbox-server-dispatch.js';
import { SQLITE_MAILBOX_FILE, SqliteMailbox } from './sqlite-mailbox.js';

const DEFAULT_IDLE_MS = 5 * 60_000;
const DEFAULT_CLIENT_LEASE_MS = 45_000;

/**
 * Cap on outbound bytes queued for a single client before it is dropped.
 *
 * `socket.write()` returns `false` once its internal queue passes the stream's
 * high-water mark; that is the signal to stop producing. This server
 * broadcasts every `mailbox.*` event to every connected client, so ignoring
 * that signal meant one client that stopped reading — a suspended process, a
 * TUI stuck behind a modal, a debugger-paused peer — made the owner buffer
 * every subsequent broadcast for it, without limit. Nothing else here is big:
 * the SQLite file is single-digit MB, so an owner holding hundreds of MB is
 * this queue and nothing else.
 *
 * Dropping is the right response rather than throttling: these are
 * notifications, and SQLite remains the authority. A client that reconnects
 * re-queries current state, so it loses nothing but the events it was already
 * too far behind to have processed.
 */
const MAX_CLIENT_WRITE_BUFFER_BYTES = 8 * 1024 * 1024;

interface ClientState {
  socket: net.Socket;
  buffer: string;
  lastSeenAt: number;
}

function parseArgs(argv: string[]): { projectDir: string } {
  let projectDir: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--project-dir') projectDir = argv[++index];
  }
  if (!projectDir) throw new Error('mailbox project server requires --project-dir');
  return { projectDir: path.resolve(projectDir) };
}

// Long-lived daemon: lean SQLite residency unless the operator says
// otherwise. Must run before any store opens.
useDaemonPerfDefaults();

const { projectDir } = parseArgs(process.argv.slice(2));
const endpoint = mailboxProjectServerEndpoint(projectDir);
const metadataPath = mailboxProjectServerMetadataPath(projectDir);
const idleInput = Number(process.env['WRONGSTACK_MAILBOX_SERVER_IDLE_MS']);
// Node clamps a timer delay above 2^31-1 ms to 1 ms: a huge "never idle out"
// value would stop the daemon at once.
const idleMs =
  Number.isFinite(idleInput) && idleInput >= 100
    ? Math.min(idleInput, 2_147_483_647)
    : DEFAULT_IDLE_MS;
const leaseInput = Number(process.env['WRONGSTACK_MAILBOX_SERVER_CLIENT_LEASE_MS']);
const clientLeaseMs =
  Number.isFinite(leaseInput) && leaseInput >= 100 ? leaseInput : DEFAULT_CLIENT_LEASE_MS;
const leaseSweepMs = Math.min(10_000, Math.max(100, Math.floor(clientLeaseMs / 3)));
const startedAt = new Date().toISOString();
const events = new EventBus();
const eventEmitter = new MailboxEventEmitter();
let mailbox: SqliteMailbox | undefined;
const clients = new Set<ClientState>();
let pendingRequests = 0;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let stopping = false;
let ready = false;
let stopAutoCompact: (() => void) | undefined;
const stopMemoryWatchdog = startSharedHeapWatchdog({
  collectStats: () => ({
    surface: 'mailbox-project-server',
    clients: clients.size,
    pendingRequests,
  }),
});

/**
 * Per-process auth token. WS-027: this daemon owns the project's message bus
 * AND its credential store, and admitted anything that could open the socket.
 * The 0600 socket only excludes other users — on Windows it does not even do
 * that — so "same-UID process" was the whole boundary. A caller must now prove
 * it could read the daemon's owner-only metadata file before it may act.
 *
 * The token is deliberately NOT part of `serverInfo`: that object is the
 * `hello` payload sent to every socket that connects, which is exactly how the
 * SAGE daemon ended up handing its own credential to the caller it meant to
 * refuse (WS-028).
 */
const authToken = randomBytes(16).toString('hex');

/**
 * Resolves once `.mailbox-server.json` — the only place the token exists — is
 * on disk.
 *
 * The endpoint bind IS the ownership election, so metadata cannot be written
 * before listening (a losing contender would clobber the winner's file). But
 * that leaves a window where the socket accepts connections and no client can
 * possibly know the token yet. Rather than have clients retry into it, the
 * daemon holds `hello` until the file is written: `hello` means "ready", and
 * the client's connect already waits for it.
 */
let markMetadataWritten: (() => void) | undefined;
const metadataWritten = new Promise<void>((resolve) => {
  markMetadataWritten = resolve;
});

const serverInfo: MailboxProjectServerInfo = {
  runtimeVersion: WRONGSTACK_RUNTIME_VERSION,
  protocolVersion: MAILBOX_PROJECT_SERVER_PROTOCOL_VERSION,
  pid: process.pid,
  projectDir,
  endpoint,
  startedAt,
};

function writeEncoded(state: ClientState, encoded: string): void {
  if (state.socket.destroyed) return;
  // A client that has stopped draining must not be allowed to grow the
  // owner's heap one broadcast at a time. `writableLength` is what is still
  // queued in this socket, so checking it before writing bounds the worst
  // case at roughly one message beyond the cap.
  if (state.socket.writableLength > MAX_CLIENT_WRITE_BUFFER_BYTES) {
    state.socket.destroy(new Error('Mailbox client fell too far behind on reads'));
    return;
  }
  state.socket.write(encoded);
}

function send(state: ClientState, message: MailboxProjectServerMessage): void {
  if (state.socket.destroyed) return;
  writeEncoded(state, encodeMailboxProjectServerMessage(message));
}

/**
 * Encode once, write to every client.
 *
 * Serializing inside the per-client loop meant the same payload was
 * stringified once per connected client. Mailbox snapshot events are tens of
 * KB, so a handful of attached surfaces (TUI, WebUI, HQ) turned every event
 * into a multiple of that in short-lived garbage — visible as a sawtooth of
 * hundreds of MB in a daemon whose database is single-digit MB.
 */
function broadcast(message: MailboxProjectServerMessage): void {
  if (clients.size === 0) return;
  const encoded = encodeMailboxProjectServerMessage(message);
  for (const state of clients) writeEncoded(state, encoded);
}

events.onAny((event, payload) => {
  if (event.startsWith('mailbox.')) broadcast({ type: 'event', event, payload });
});
eventEmitter.subscribe((event) => broadcast({ type: 'mailbox-event', event }));

function serverStatus(): MailboxServerOperations['ping']['result'] {
  const databasePath = mailbox?.databasePath ?? path.join(projectDir, SQLITE_MAILBOX_FILE);
  return {
    ...serverInfo,
    clients: clients.size,
    pendingRequests,
    messagePath: databasePath,
    databasePath,
    storageKind: 'sqlite',
  };
}

async function dispatch(op: MailboxServerOperationName, rawArgs: unknown): Promise<unknown> {
  const activeMailbox = mailbox;
  if (activeMailbox === undefined) throw new Error('Mailbox SQLite owner is not initialized');
  if (op === 'ping') return serverStatus();
  return dispatchMailboxOperation(activeMailbox, op, rawArgs);
}

/**
 * WS-027: every `request` and `shutdown` must carry the per-process token.
 * `heartbeat` does not — it carries no id to answer on, mutates nothing, and
 * only refreshes the sender's own lease.
 */
function checkAuthToken(state: ClientState, message: MailboxProjectServerClientMessage): boolean {
  if (message.type === 'heartbeat') return true;
  // Constant-time: `===` returns at the first differing byte, so its timing
  // leaks the shared-prefix length. This was the FIFTH such daemon — the audit
  // named four, and this one only surfaced when the wiring test below was
  // written, which is the argument for having the test at all.
  if (timingSafeTokenEqual(message.authToken, authToken)) return true;
  void metadataGuard.reassert();
  send(state, {
    type: 'response',
    id: message.id,
    ok: false,
    error:
      'Mailbox IPC request rejected: missing or invalid authToken. ' +
      'Reconnect to refresh metadata (.mailbox-server.json#authToken).',
    errorName: 'UnauthorizedMailboxRequest',
  });
  return false;
}

function handleMessage(state: ClientState, message: MailboxProjectServerClientMessage): void {
  state.lastSeenAt = Date.now();
  if (!checkAuthToken(state, message)) return;
  if (message.type === 'heartbeat') return;
  if (message.type === 'shutdown') {
    send(state, {
      type: 'response',
      id: message.id,
      ok: true,
      result: { stopped: true, pid: process.pid, reason: message.reason },
    });
    setImmediate(() => void stop(message.reason ?? 'client-request'));
    return;
  }
  pendingRequests++;
  void dispatch(message.op, message.args)
    .then((result) => {
      // JSON.stringify omits `undefined` object properties. Keep successful
      // void operations structurally valid for the client runtime guard.
      send(state, { type: 'response', id: message.id, ok: true, result: result ?? null });
    })
    .catch((error) => {
      send(state, {
        type: 'response',
        id: message.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        errorName: error instanceof Error ? error.name : undefined,
      });
    })
    .finally(() => {
      pendingRequests = Math.max(0, pendingRequests - 1);
      // A client may disconnect while its last request is still settling.
      // The close handler cannot arm the idle timer while pendingRequests > 0,
      // so re-check after every request or an owner can remain alive forever.
      scheduleIdleStop();
    });
}

function onData(state: ClientState, chunk: string): void {
  state.lastSeenAt = Date.now();
  state.buffer += chunk;
  while (true) {
    const newline = state.buffer.indexOf('\n');
    if (newline < 0) {
      if (state.buffer.length > MAILBOX_PROJECT_SERVER_MAX_FRAME_CHARS) {
        state.socket.destroy(new Error('Mailbox request frame exceeded maximum size'));
      }
      return;
    }
    if (newline > MAILBOX_PROJECT_SERVER_MAX_FRAME_CHARS) {
      state.socket.destroy(new Error('Mailbox request frame exceeded maximum size'));
      return;
    }
    const line = state.buffer.slice(0, newline);
    state.buffer = state.buffer.slice(newline + 1);
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      state.socket.destroy(new Error('Invalid mailbox project server request'));
      return;
    }
    if (!isMailboxProjectServerClientMessage(parsed)) {
      state.socket.destroy(new Error('Invalid mailbox project server request'));
      return;
    }
    handleMessage(state, parsed);
  }
}

/**
 * Arm the idle shutdown, but NEVER re-arm an already-armed timer.
 *
 * The `idleTimer` guard is load-bearing. `leaseSweep` calls this on every
 * tick, and the sweep interval is derived from the client lease
 * (`min(10s, lease/3)` — 10s at the 45s default) while `idleMs` defaults to
 * five minutes. A `clearTimeout` + re-arm here therefore reset the countdown
 * every 10 seconds and the idle stop could never fire: with zero clients the
 * daemon lived forever, and the longer the configured idle window the more
 * certainly it starved.
 *
 * Measured before the fix (no client, default lease): idle=5s exited at
 * 5164ms, idle=20s was still alive after 45s. The tests missed it because
 * every one of them sets an idle far BELOW the sweep interval (150ms in
 * `mailbox-project-server.test.ts`), which is the only regime where a
 * re-arming implementation still works.
 *
 * Not re-arming is safe because the timer only exists while `clients.size`
 * is 0: a connecting client clears it (see the `createServer` handler), and
 * nothing else can register activity in the meantime.
 */
function scheduleIdleStop(): void {
  // The lease sweep also runs during metadata/ACL initialization. Starting
  // the idle countdown there can stop the owner before startup finishes.
  if (!ready || stopping || clients.size > 0 || pendingRequests > 0 || idleTimer) return;
  idleTimer = setTimeout(() => void stop('idle-timeout'), idleMs);
  idleTimer.unref?.();
}

// A daemon of another release can own a different endpoint for this project
// and still write the same metadata file; a refused token puts ours back.
const metadataGuard = createProjectMetadataReasserter({
  metadataPath,
  endpoint,
  pid: process.pid,
  write: writeMetadata,
});

async function writeMetadata(): Promise<void> {
  await fsPromises.mkdir(projectDir, { recursive: true });
  // The token lives ONLY in this owner-only file, never on the wire (WS-027).
  //
  // `mode: 0o600` is honored on POSIX but Node ignores it on Windows, where the
  // file would instead inherit the `projectDir` ACLs. The IPC endpoint offers
  // no exclusion on Windows either (see WS-027 above), so a world-readable
  // `projectDir` used to mean any local user could read this file, lift the
  // token, and bypass WS-027 entirely. `restrictFilePermissions` closes that:
  // on Windows it strips inherited ACEs and grants full control to the owner
  // alone (`icacls /inheritance:r /grant:r <user>:(F)`), on POSIX it re-applies
  // the same 0600 the write already requested.
  //
  // It runs BEFORE `markMetadataWritten()` so no client is greeted — and
  // therefore no client can read the token — until the ACL is in place. That
  // costs one `icacls` spawn per daemon start on Windows, paid once: this
  // function is called exactly once, right after the ownership election.
  const metadata: MailboxProjectServerMetadata = { ...serverStatus(), authToken };
  // WS-059: this used to be a hand-rolled write + rename with an
  // `rm(metadataPath)` fallback. On Windows the rename fails whenever a reader
  // holds the destination, so the rm branch was not an edge case — it was the
  // common path. Between the `rm` and the retry `rename` the metadata file does
  // not exist, and a client that reads it in that window concludes there is no
  // daemon and spawns a second one, breaking the one-daemon-per-project
  // invariant this file exists to hold.
  //
  // `atomicWrite` replaces in place with a bounded rename retry (~4s of
  // backoff over the transient Windows codes) and never unlinks the
  // destination first, so the file is present at every instant.
  await atomicWrite(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
  await restrictFilePermissions(metadataPath, {
    label: 'mailbox-server-metadata',
    // stdio is 'ignore' for this detached process; stderr is where its other
    // diagnostics go, so a failed hardening is at least consistent with them.
    warn: (message) => process.stderr.write(`${message}\n`),
  });
}

/**
 * Delete this process's metadata file.
 *
 * WS-059: the pid check here is read-then-delete, which is a TOCTOU on its
 * own — a successor daemon can write its metadata between the read and the
 * `rm`, and this process then deletes the LIVE daemon's file. Clients can no
 * longer find the running daemon and spawn duplicates.
 *
 * The pid comparison cannot be made atomic on a filesystem, so the fix is
 * ordering rather than a tighter check: `stop()` calls this BEFORE closing the
 * server. While this process still holds the endpoint, no successor can have
 * won the ownership election, so no successor metadata can exist to delete.
 * That makes shutdown the mirror of startup, which already documents that the
 * endpoint bind IS the election and metadata cannot be written before `listen`.
 *
 * The pid check is retained as a backstop for the case this ordering does not
 * cover: a stale file left by a previous, crashed process.
 */
async function removeOwnedMetadata(): Promise<void> {
  try {
    const current = JSON.parse(await fsPromises.readFile(metadataPath, 'utf8')) as {
      pid?: number;
    };
    if (current.pid === process.pid) await fsPromises.rm(metadataPath, { force: true });
  } catch {
    // Missing or replaced metadata does not belong to this process.
  }
}

async function stop(_reason: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  metadataGuard.disable();
  // DIAGNOSTIC: the stop reason is otherwise unobservable — the client spawns
  // this daemon with stdio:'ignore', so anything not written to stderr is lost
  // when the daemon exits. Harmless in production precisely because stderr is
  // discarded there; captured when a test sets WRONGSTACK_CATALOG_DAEMON_LOG.
  process.stderr.write(`[mailbox] project server stopping: ${_reason}\n`);
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = undefined;
  clearInterval(leaseSweep);
  stopAutoCompact?.();
  // WS-059: remove the metadata BEFORE releasing the endpoint. The endpoint
  // bind is the ownership election, so while it is still held no successor
  // daemon can exist — and therefore no successor metadata can be deleted by
  // the pid-compare below. Doing this after `server.close()` left a window in
  // which a successor bound, wrote its metadata, and had it removed by this
  // process, leaving a live daemon that no client could find.
  //
  // The cost is a brief interval where this daemon is still serving but has no
  // metadata. That direction is safe: a client that cannot read the token
  // fails and retries, and it cannot spawn a replacement until the endpoint is
  // actually free. The opposite ordering silently corrupts the invariant.
  await removeOwnedMetadata();
  // Stop accepting new clients, then actively close the existing sockets.
  // Waiting for server.close() before closing them deadlocks explicit shutdown:
  // the requester keeps its IPC socket open while server.close() waits for
  // that same socket to disappear.
  const serverClosed = new Promise<void>((resolve) => server.close(() => resolve()));
  for (const state of clients) state.socket.end();
  const forceCloseTimer = setTimeout(() => {
    for (const state of clients) state.socket.destroy();
  }, 1_000);
  forceCloseTimer.unref?.();
  await serverClosed;
  clearTimeout(forceCloseTimer);
  for (const state of clients) state.socket.destroy();
  clients.clear();
  await mailbox?.close().catch(() => {});
  mailbox = undefined;
  if (process.platform !== 'win32') {
    await fsPromises.rm(endpoint, { force: true }).catch(() => {});
  }
  await stopMemoryWatchdog();
}

const server = net.createServer((socket) => {
  if (stopping) {
    socket.destroy();
    return;
  }
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = undefined;
  socket.setEncoding('utf8');
  const state: ClientState = { socket, buffer: '', lastSeenAt: Date.now() };
  clients.add(state);
  // Greet only once the token is readable on disk — see `metadataWritten`.
  void metadataWritten.then(() => {
    if (!socket.destroyed) send(state, { type: 'hello', ...serverInfo });
  });
  socket.on('data', (chunk: string) => onData(state, chunk));
  socket.on('error', () => {
    // Close handling below owns cleanup; socket errors must not crash the owner.
  });
  socket.on('close', () => {
    clients.delete(state);
    scheduleIdleStop();
  });
});

const leaseSweep = setInterval(() => {
  const cutoff = Date.now() - clientLeaseMs;
  for (const state of clients) {
    if (state.lastSeenAt < cutoff) state.socket.destroy();
  }
  scheduleIdleStop();
}, leaseSweepMs);
leaseSweep.unref?.();

// The bind is the ownership election, including the probe-then-reclaim ladder
// for an endpoint whose owner died without cleanup. Shared with every other
// project daemon via `bindProjectEndpoint`.
void (async () => {
  const bind = await bindProjectEndpoint({ server, endpoint, service: 'mailbox' });
  if (bind.outcome === 'already-owned') {
    process.exitCode = 0;
    return;
  }
  if (bind.outcome === 'failed') {
    process.stderr.write(`mailbox project server failed: ${bind.error.message}\n`);
    process.exitCode = 1;
    return;
  }
  if (bind.reclaimedStaleEndpoint) {
    process.stderr.write(`mailbox project server reclaimed stale endpoint ${endpoint}\n`);
  }
  server.on('error', (error: NodeJS.ErrnoException) => {
    if (stopping) return;
    process.stderr.write(`mailbox project server error: ${error.message}\n`);
    process.exitCode = 1;
  });
  try {
    // Open SQLite only after winning the election so losing detached
    // contenders never become DB owners.
    mailbox = new SqliteMailbox(projectDir, events, eventEmitter);
  } catch {
    void stop('sqlite-initialization-failed').finally(() => {
      process.exitCode = 1;
    });
    return;
  }
  stopAutoCompact = mailbox.startAutoCompactTimer();
  try {
    await writeMetadata();
    metadataGuard.enable();
    ready = true;
    markMetadataWritten?.();
    scheduleIdleStop();
  } catch {
    void stop('metadata-write-failed').finally(() => {
      process.exitCode = 1;
    });
  }
})();

/**
 * One SIGINT/SIGTERM pair per PROCESS, not per module instance.
 *
 * The in-process test harness imports this module once per test case with a
 * `?case=<n>` query URL, so every case evaluates this module body fresh; a
 * bare top-level `process.once(signal, ...)` loop accumulates one handler
 * pair per case until Node raises MaxListenersExceededWarning in every
 * coverage run. The guard lives on globalThis under a Symbol.for key: the
 * first evaluation registers the pair, every evaluation re-targets it at its
 * own `stop`, and a fired signal removes the pair (once semantics).
 */
interface MailboxSignalGuard {
  arm(stop: (signal: string) => Promise<void>): void;
}
const SIGNAL_GUARD: unique symbol = Symbol.for('wrongstack.mailbox.project-server.signalGuard');

const signalGuardStore = globalThis as typeof globalThis & {
  [SIGNAL_GUARD]?: MailboxSignalGuard | undefined;
};
let signalGuard = signalGuardStore[SIGNAL_GUARD];
if (!signalGuard) {
  let current: (signal: string) => Promise<void> = async () => undefined;
  let armed = false;
  const handlers = new Map<string, () => void>();
  const disarm = (): void => {
    if (!armed) return;
    armed = false;
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    handlers.clear();
  };
  signalGuard = {
    arm(next) {
      current = next;
      if (armed) return;
      armed = true;
      for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        const handler = (): void => {
          disarm();
          void current(signal).finally(() => {
            process.exitCode = 0;
          });
        };
        handlers.set(signal, handler);
        process.on(signal, handler);
      }
    },
  };
  signalGuardStore[SIGNAL_GUARD] = signalGuard;
}
signalGuard.arm(stop);
