#!/usr/bin/env node

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import * as fsPromises from 'node:fs/promises';
import * as net from 'node:net';
import * as path from 'node:path';
import { EventBus } from '@wrongstack/core/kernel';
import { restrictFilePermissions } from '@wrongstack/core/security';
import type { ScoredEntry } from '@wrongstack/core/types';
import {
  atomicWrite,
  canonicalProjectRoot,
  startSharedHeapWatchdog,
  useDaemonPerfDefaults,
} from '@wrongstack/core/utils';
import { bindProjectEndpoint } from '@wrongstack/persistence';
import { SqliteMemoryPort } from './memory-port.js';
import {
  resolveProjectSageStorageRoot,
  sageProjectServerEndpoint,
  sageProjectServerMetadataPath,
} from './project-server-endpoint.js';
import {
  encodeSageProjectServerMessage,
  SAGE_PROJECT_SERVER_PROTOCOL_VERSION,
  type SageProjectServerClientMessage,
  type SageProjectServerInfo,
  type SageProjectServerMessage,
  type SageProjectServerMetadata,
  type SageRequestMetadata,
  type SageServerOperationName,
  type SageServerOperations,
} from './project-server-protocol.js';
import type { SageServiceLike } from './service-contract.js';
import type {
  FindMemoriesForFileOptions,
  FindMemoriesForFileResponse,
  SageBackfillOptions,
  SageBackfillReport,
} from './types.js';

const DEFAULT_IDLE_MS = 5 * 60_000;
const AUTO_HYGIENE_INTERVAL_MS = 60 * 60_000;
const MAX_FRAME_BUFFER_CHARS = 8 * 1024 * 1024;
/**
 * Dispatch duration above which a request is reported on stderr.
 *
 * SQLite is synchronous and this daemon runs one event loop, so a slow
 * operation is never slow for its caller alone — every other client of the
 * project waits behind it, and a queue deep enough makes them fail with their
 * own 30s call timeout somewhere else entirely. That is how an FTS join-order
 * regression (seconds per `searchSage` under one SQLite build, milliseconds
 * under another) stayed invisible until unrelated ops started timing out. One
 * throttled line names the op and the queue depth instead.
 *
 * `WRONGSTACK_SAGE_SLOW_OP_MS` overrides the threshold; 0 reports every
 * request, which is what the lifecycle test asserts against.
 */
const SLOW_OPERATION_WARN_MS = (() => {
  const raw = Number(process.env['WRONGSTACK_SAGE_SLOW_OP_MS']);
  return Number.isFinite(raw) && raw >= 0 ? raw : 1_000;
})();
/** Per-op throttle so a persistent regression cannot flood stderr. */
const SLOW_OPERATION_THROTTLE_MS = 60_000;
const lastSlowReportAt = new Map<string, number>();

function reportSlowOperation(op: SageServerOperationName, durationMs: number): void {
  if (durationMs < SLOW_OPERATION_WARN_MS) return;
  const now = Date.now();
  const previous = lastSlowReportAt.get(op);
  if (previous !== undefined && now - previous < SLOW_OPERATION_THROTTLE_MS) return;
  lastSlowReportAt.set(op, now);
  process.stderr.write(
    `sage project server: ${op} took ${Math.round(durationMs)}ms ` +
      `(queued=${pendingRequests}, clients=${clients.size}) — every client waits behind it
`,
  );
}
const MAX_LEGACY_IMPORT_BYTES = 5 * 1024 * 1024;

interface ParsedArgs {
  projectRoot: string;
  directory?: string | undefined;
}

interface ClientState {
  socket: net.Socket;
  buffer: string;
  active: Map<number, AbortController>;
  /**
   * Server-assigned per-connection nonce. The server stamps this on
   * every request's `meta.clientId` and never honours the client-supplied
   * value, so two different connections can never claim the same
   * `clientId` in the audit log.
   */
  clientId: string;
}

type CompleteSageStore = SqliteMemoryPort &
  SageServiceLike & {
    recoverSage(id: string, reason?: string): Promise<import('./types.js').Sage>;
    backfillRecoverable(options?: SageBackfillOptions): Promise<SageBackfillReport>;
    findMemoriesForFile(
      filePath: string,
      options?: FindMemoriesForFileOptions,
    ): Promise<FindMemoriesForFileResponse>;
  };

function parseArgs(argv: string[]): ParsedArgs {
  let projectRoot: string | undefined;
  let directory: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--project-root') projectRoot = argv[++index];
    else if (arg === '--directory') directory = argv[++index];
  }
  if (!projectRoot) throw new Error('SAGE project server requires --project-root');
  return {
    projectRoot: path.resolve(projectRoot),
    ...(directory ? { directory } : {}),
  };
}

// Long-lived daemon: lean SQLite residency unless the operator says
// otherwise. Must run before any store opens.
useDaemonPerfDefaults();

const parsed = parseArgs(process.argv.slice(2));
const projectRoot = canonicalProjectRoot(parsed.projectRoot);
const storageRoot = resolveProjectSageStorageRoot(projectRoot, parsed.directory);
const endpoint = sageProjectServerEndpoint(projectRoot, parsed.directory);
const metadataPath = sageProjectServerMetadataPath(projectRoot, parsed.directory);
const idleMsInput = Number(process.env['WRONGSTACK_SAGE_SERVER_IDLE_MS']);
const idleMs = Number.isFinite(idleMsInput) && idleMsInput >= 100 ? idleMsInput : DEFAULT_IDLE_MS;
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
const clients = new Set<ClientState>();
let pendingRequests = 0;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let stopping = false;
let lastAutomaticHygieneAt = 0;
let lastAutomaticHygieneReport: SageServerOperations['hygiene']['result'] | undefined;
let automaticHygieneInFlight: Promise<SageServerOperations['hygiene']['result']> | undefined;
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
    automaticHygieneInFlight: automaticHygieneInFlight !== undefined,
  }),
});

const serverInfo: SageProjectServerInfo = {
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

let resolveReady: (() => void) | undefined;
let rejectReady: ((error: unknown) => void) | undefined;
const ready = new Promise<void>((resolve, reject) => {
  resolveReady = resolve;
  rejectReady = reject;
});

/**
 * Cap on outbound bytes queued for one client before it is dropped. This
 * server broadcasts `memory.*` events to every client, and `socket.write()`
 * buffers without limit when its `false` return is ignored — so one client
 * that stops reading would otherwise grow the owner's heap indefinitely.
 * Memory state is in SQLite; a dropped client re-reads it on reconnect.
 */
const MAX_CLIENT_WRITE_BUFFER_BYTES = 8 * 1024 * 1024;

function writeEncoded(state: ClientState, encoded: string): void {
  if (state.socket.destroyed) return;
  if (state.socket.writableLength > MAX_CLIENT_WRITE_BUFFER_BYTES) {
    state.socket.destroy(new Error('SAGE client fell too far behind on reads'));
    return;
  }
  state.socket.write(encoded);
}

function send(state: ClientState, message: SageProjectServerMessage): void {
  writeEncoded(state, encodeSageProjectServerMessage(message));
}

/** Encode once, write to every client — see the mailbox owner for rationale. */
function broadcast(message: SageProjectServerMessage): void {
  if (clients.size === 0) return;
  const encoded = encodeSageProjectServerMessage(message);
  for (const state of clients) {
    try {
      writeEncoded(state, encoded);
    } catch {
      state.socket.destroy();
    }
  }
}

events.onPattern('memory.*', (event, payload) => {
  const store = requestContext.getStore();
  // Strip server-only secrets (authToken) before broadcasting to every
  // connected client. Without this, an event listener on one client
  // would receive another client's authToken via the broadcast meta,
  // turning the per-connection token into a shared secret.
  const safeMeta = store
    ? {
        clientId: store.clientId,
        ...(store.sessionId !== undefined ? { sessionId: store.sessionId } : {}),
        ...(store.traceId !== undefined ? { traceId: store.traceId } : {}),
      }
    : undefined;
  broadcast({
    type: 'event',
    event,
    payload,
    meta: safeMeta,
  });
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

async function importLegacyFiles(
  files: string[],
): Promise<SageServerOperations['importLegacyFiles']['result']> {
  const result = { imported: 0, skipped: 0, files: 0 };
  let totalBytes = 0;
  for (const file of files) {
    // Path containment: every imported file must live under `projectRoot`.
    // This closes the threat where a same-UID caller invokes
    // `importLegacyFiles(['/etc/passwd'])` or `['~/.ssh/id_rsa'])`. Files
    // that legitimately live outside the project (e.g. a cross-project
    // migration export staged in /tmp) require the operator to first copy
    // them into the project boundary — explicit and reversible.
    //
    // Defense-in-depth: `path.resolve()` only normalises lexically and
    // does NOT resolve symlinks. A symlink inside `projectRoot` that
    // points outside it would pass the lexical check and then be read
    // by `fsPromises.readFile()` (which follows symlinks), so we
    // resolve to the real path first and check containment on that.
    const resolved = await fsPromises.realpath(file);
    const rel = path.relative(projectRoot, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`importLegacyFiles: file path must stay inside the project root: ${file}`);
    }
    const stat = await fsPromises.stat(resolved);
    totalBytes += stat.size;
    if (totalBytes > MAX_LEGACY_IMPORT_BYTES) {
      throw new Error(`Legacy memory import exceeds ${MAX_LEGACY_IMPORT_BYTES} bytes`);
    }
    const raw = await fsPromises.readFile(resolved, 'utf8');
    const imported = await store.importLegacy(raw);
    result.imported += imported.imported;
    result.skipped += imported.skipped;
    result.files += 1;
  }
  return result;
}

async function runHygiene(
  args: SageServerOperations['hygiene']['args'],
): Promise<SageServerOperations['hygiene']['result']> {
  if (args.automatic) {
    const now = Date.now();
    if (lastAutomaticHygieneReport && now - lastAutomaticHygieneAt < AUTO_HYGIENE_INTERVAL_MS) {
      return lastAutomaticHygieneReport;
    }
    if (automaticHygieneInFlight) return automaticHygieneInFlight;
    automaticHygieneInFlight = store
      .hygiene(args.options)
      .then((report) => {
        lastAutomaticHygieneAt = Date.now();
        lastAutomaticHygieneReport = report;
        return report;
      })
      .finally(() => {
        automaticHygieneInFlight = undefined;
      });
    return automaticHygieneInFlight;
  }
  return store.hygiene(args.options);
}

async function dispatch(
  op: SageServerOperationName,
  rawArgs: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  await ready;
  switch (op) {
    case 'ping':
      return serverStatus();
    case 'readAll':
      return store.readAll();
    case 'read': {
      const args = rawArgs as SageServerOperations['read']['args'];
      return store.read(args.scope);
    }
    case 'remember': {
      const args = rawArgs as SageServerOperations['remember']['args'];
      return store.remember(args.text, args.scope, args.metadata);
    }
    case 'forget': {
      const args = rawArgs as SageServerOperations['forget']['args'];
      return store.forget(args.query, args.scope);
    }
    case 'consolidate': {
      const args = rawArgs as SageServerOperations['consolidate']['args'];
      return store.consolidate(args.scope);
    }
    case 'clear': {
      const args = rawArgs as SageServerOperations['clear']['args'];
      return store.clear(args.scope);
    }
    case 'list': {
      const args = rawArgs as SageServerOperations['list']['args'];
      return store.list(args.scope, args.limit);
    }
    case 'search': {
      const args = rawArgs as SageServerOperations['search']['args'];
      return store.search(args.query, args.scope, args.limit);
    }
    case 'findRelated': {
      const args = rawArgs as SageServerOperations['findRelated']['args'];
      const related = store.findRelated?.(args.text, args.scope, args.limit);
      return related ?? store.search(args.text, args.scope, args.limit);
    }
    case 'scoreRelevant': {
      const args = rawArgs as SageServerOperations['scoreRelevant']['args'];
      const scored = store.scoreRelevant?.(args.context, args.scope, args.limit);
      if (scored) return scored;
      const fallback = await store.search(args.context.currentTask, args.scope, args.limit);
      return fallback.map(
        (entry, index): ScoredEntry => ({
          ...entry,
          score: Math.max(0.1, 1 - index * 0.05),
          matchReason: 'sage-server lexical fallback',
        }),
      );
    }
    case 'stats':
      return store.stats();
    case 'listSage': {
      const args = rawArgs as SageServerOperations['listSage']['args'];
      return store.listSage(args.statuses);
    }
    case 'listSagePage': {
      const args = rawArgs as SageServerOperations['listSagePage']['args'];
      return store.listSagePage(args.options);
    }
    case 'getSage': {
      const args = rawArgs as SageServerOperations['getSage']['args'];
      return store.getSage(args.id);
    }
    case 'rememberSage': {
      const args = rawArgs as SageServerOperations['rememberSage']['args'];
      return store.rememberSage(args.input);
    }
    case 'updateSage': {
      const args = rawArgs as SageServerOperations['updateSage']['args'];
      // Force guard: any `status:'deleted'` patch arriving over IPC must
      // carry `force: true`. The store-side check in `sqlite-store-update.ts`
      // only blocks permanent-persistence deletes; non-permanent memories
      // were soft-deletable via raw `{status:'deleted'}` patch without
      // any authorization. This dispatch-layer gate closes that gap
      // regardless of the patch's other fields.
      //
      // Note: the in-process candidate-resolution path
      // (`sqlite-store-candidates.ts:resolveSqliteCandidate`) deliberately
      // does NOT pass `force: true`. Its target read is captured before
      // this gate applies, and the store-side permanent-guard still fires
      // when the target is permanent at delete-time. Adding `force: true`
      // there would silently succeed for permanent-target deletion races,
      // which the `sqlite-behavior-coverage.test.ts` promotion-race test
      // covers as `applied: false`. Two paths, two contracts:
      //   - IPC `updateSage` patch → force required.
      //   - In-process `ctx.updateSage` from candidate resolve → force
      //     intentionally omitted so the permanent-guard fires.
      if (!args?.id || !args?.patch) {
        throw new Error('SAGE IPC updateSage requires { id, patch } args.');
      }
      if (args.patch.status === 'deleted' && args.patch.force !== true) {
        throw new Error(
          `SAGE IPC updateSage cannot set status:'deleted' without force:true. ` +
            `Pass { force: true } in the patch.`,
        );
      }
      return store.updateSage(args.id, args.patch);
    }
    case 'deleteSage': {
      const args = rawArgs as SageServerOperations['deleteSage']['args'];
      return store.deleteSage(args.id, args.reason, args.options);
    }
    case 'retrieveForPath': {
      const args = rawArgs as SageServerOperations['retrieveForPath']['args'];
      return store.retrieveForPath([args.options.path], args.options);
    }
    case 'searchSage': {
      const args = rawArgs as SageServerOperations['searchSage']['args'];
      return store.searchSage(args.query, args.options);
    }
    case 'searchSageWithBreakdown': {
      const args = rawArgs as SageServerOperations['searchSageWithBreakdown']['args'];
      // The rich variant is optional on the surface — only the
      // vector-augmented in-process port implements it. When the
      // daemon is talking to a non-augmented store, throw a
      // recognizable error so the client can fall back to
      // `searchSage` (which always works).
      if (typeof store.searchSageWithBreakdown !== 'function') {
        throw new Error('searchSageWithBreakdown is not available on this store');
      }
      return store.searchSageWithBreakdown(args.query, args.options);
    }
    case 'unifiedSearch': {
      const args = rawArgs as SageServerOperations['unifiedSearch']['args'];
      return store.unifiedSearchService(args.query, args.options);
    }
    case 'findRelatedSage': {
      const args = rawArgs as SageServerOperations['findRelatedSage']['args'];
      return store.findRelatedSage(args.memoryIds, args.options);
    }
    case 'recordInjection': {
      const args = rawArgs as SageServerOperations['recordInjection']['args'];
      return store.recordInjection(args.memoryIds, args.trigger, args.sessionId);
    }
    case 'recordUse': {
      const args = rawArgs as SageServerOperations['recordUse']['args'];
      return store.recordUse(args.memoryIds, args.source, args.sessionId);
    }
    case 'retrieveForAudience': {
      const args = rawArgs as SageServerOperations['retrieveForAudience']['args'];
      return store.retrieveForAudience(
        args.context,
        args.limit,
        undefined,
        args.sessionId,
        args.includeAllSessions,
      );
    }
    case 'graphFor': {
      const args = rawArgs as SageServerOperations['graphFor']['args'];
      return store.graphFor(args.query, args.maxDepth, args.limit);
    }
    case 'verify': {
      const args = rawArgs as SageServerOperations['verify']['args'];
      return store.verify(args.memoryId, signal);
    }
    case 'hygiene':
      return runHygiene(rawArgs as SageServerOperations['hygiene']['args']);
    case 'listCandidates': {
      const args = rawArgs as SageServerOperations['listCandidates']['args'];
      return store.listCandidates(args.includeResolved);
    }
    case 'createCandidate': {
      const args = rawArgs as SageServerOperations['createCandidate']['args'];
      return store.createCandidate(args.input);
    }
    case 'resolveCandidate': {
      const args = rawArgs as SageServerOperations['resolveCandidate']['args'];
      return store.resolveCandidate(args.candidateId, args.decision, args.reason);
    }
    case 'acceptCandidate': {
      const args = rawArgs as SageServerOperations['acceptCandidate']['args'];
      return store.acceptCandidate(args.candidateId);
    }
    case 'rejectCandidate': {
      const args = rawArgs as SageServerOperations['rejectCandidate']['args'];
      return store.rejectCandidate(args.candidateId, args.reason);
    }
    case 'recoverSage': {
      const args = rawArgs as SageServerOperations['recoverSage']['args'];
      return store.recoverSage(args.id, args.reason);
    }
    case 'backfillRecoverable': {
      const args = rawArgs as SageServerOperations['backfillRecoverable']['args'];
      return store.backfillRecoverable(args.options);
    }
    case 'findMemoriesForFile': {
      const args = rawArgs as SageServerOperations['findMemoriesForFile']['args'];
      return store.findMemoriesForFile(args.filePath, args.options);
    }
    case 'readAudit': {
      const args = rawArgs as SageServerOperations['readAudit']['args'];
      return store.readAudit(args.limit);
    }
    case 'importLegacyFiles': {
      const args = rawArgs as SageServerOperations['importLegacyFiles']['args'];
      return importLegacyFiles(args.files);
    }
    case 'consolidateSession': {
      const args = rawArgs as SageServerOperations['consolidateSession']['args'];
      return store.consolidateSession(args.input);
    }
  }
}

function checkAuthToken(state: ClientState, message: SageProjectServerClientMessage): boolean {
  // WS-028: `shutdown` is now gated too. It stops the daemon for every client
  // in the project — a denial of service any same-UID process could trigger
  // with one unauthenticated frame. `cancel` stays ungated: it only reaches
  // the sending connection's own `state.active` map.
  const supplied =
    message.type === 'request'
      ? message.meta.authToken
      : message.type === 'shutdown'
        ? message.authToken
        : undefined;
  if ((message.type === 'request' || message.type === 'shutdown') && supplied !== authToken) {
    send(state, {
      type: 'response',
      id: message.id,
      ok: false,
      error:
        'SAGE IPC request rejected: missing or invalid authToken. ' +
        'Reconnect to refresh metadata (server.json#authToken).',
      errorName: 'UnauthorizedSageRequest',
    });
    return false;
  }
  return true;
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
  void requestContext
    .run(safeMeta, () => dispatch(message.op, message.args, controller.signal))
    .then((result) => {
      send(state, { type: 'response', id: message.id, ok: true, result });
    })
    .catch((error) => {
      try {
        send(state, {
          type: 'response',
          id: message.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          errorName: error instanceof Error ? error.name : undefined,
        });
      } catch {
        // socket already destroyed or write failed — nothing more to do
      }
    })
    .finally(() => {
      state.active.delete(message.id);
      pendingRequests = Math.max(0, pendingRequests - 1);
      reportSlowOperation(message.op, Date.now() - startedAt);
    });
}

function onData(state: ClientState, chunk: string): void {
  state.buffer += chunk;
  if (state.buffer.length > MAX_FRAME_BUFFER_CHARS) {
    state.socket.destroy(new Error('SAGE request frame exceeded maximum size'));
    return;
  }
  while (true) {
    const newline = state.buffer.indexOf('\n');
    if (newline < 0) return;
    const line = state.buffer.slice(0, newline);
    state.buffer = state.buffer.slice(newline + 1);
    if (!line) continue;
    let message: SageProjectServerClientMessage;
    try {
      message = JSON.parse(line) as SageProjectServerClientMessage;
    } catch {
      state.socket.destroy(new Error('Invalid SAGE project server request'));
      return;
    }
    handleMessage(state, message);
  }
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
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = undefined;
  // WS-059: remove metadata BEFORE releasing the endpoint. The bind is the
  // ownership election, so while it is still held no successor daemon can
  // exist — and therefore none can have its metadata deleted by the
  // read-then-delete pid compare in `removeOwnedMetadata`.
  await removeOwnedMetadata();
  // Destroy client sockets BEFORE awaiting close(): net.Server.close() only
  // fires its callback once every connection has ended, so awaiting it with
  // live clients deadlocked this function forever — and with the metadata
  // already removed above, the zombie kept the endpoint bound while
  // server.json was gone. A successor's EADDRINUSE probe then got an answer
  // from the zombie, concluded "healthy owner", and exited: SAGE permanently
  // dead for the project. The kanban daemon
  // (packages/kanban/src/server/project-server.ts) is the reference
  // ordering, including the bounded close for Windows named-pipe handles
  // the kernel can retain.
  for (const state of clients) {
    for (const controller of state.active.values()) {
      controller.abort(new Error('SAGE project server stopping'));
    }
    state.socket.destroy();
  }
  clients.clear();
  await new Promise<void>((resolve) => {
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
    const timer = setTimeout(() => resolve(), 500);
    timer.unref?.();
  });
  await store.dispose().catch(() => {});
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
  // Server-assigned nonce. Pairs with `pid`+`endpoint` so audit log
  // entries are correlatable to a specific connection without trusting
  // any value the client supplied.
  const clientId = `sage-${process.pid}-${randomBytes(8).toString('hex')}`;
  const state: ClientState = { socket, buffer: '', active: new Map(), clientId };
  clients.add(state);
  send(state, { type: 'hello', ...serverInfo });
  socket.on('data', (chunk: string) => onData(state, chunk));
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
    resolveReady?.();
    scheduleIdleStop();
  } catch (error) {
    rejectReady?.(error);
    await stop('initialization-failed').catch(() => {});
    process.exitCode = 1;
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
interface SageSignalGuard {
  arm(stop: (signal: string) => Promise<void>): void;
}
const SIGNAL_GUARD: unique symbol = Symbol.for('wrongstack.sage.project-server.signalGuard');

const signalGuardStore = globalThis as typeof globalThis & {
  [SIGNAL_GUARD]?: SageSignalGuard | undefined;
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
