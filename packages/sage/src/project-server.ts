#!/usr/bin/env node

import { AsyncLocalStorage } from 'node:async_hooks';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as net from 'node:net';
import * as path from 'node:path';
import { EventBus } from '@wrongstack/core/kernel';
import type { ScoredEntry } from '@wrongstack/core/types';
import { canonicalProjectRoot, useDaemonPerfDefaults } from '@wrongstack/core/utils';
import {
  ensureSageProjectServerSocketDirectory,
  resolveProjectSageStorageRoot,
  sageProjectServerEndpoint,
  sageProjectServerMetadataPath,
} from './project-server-endpoint.js';
import {
  SAGE_PROJECT_SERVER_PROTOCOL_VERSION,
  type SageProjectServerClientMessage,
  type SageProjectServerInfo,
  type SageProjectServerMessage,
  type SageRequestMetadata,
  type SageServerOperationName,
  type SageServerOperations,
  encodeSageProjectServerMessage,
} from './project-server-protocol.js';
import type { SageServiceLike } from './service-contract.js';
import { SqliteMemoryPort } from './memory-port.js';
import type {
  FindMemoriesForFileOptions,
  FindMemoriesForFileResponse,
  SageBackfillOptions,
  SageBackfillReport,
} from './types.js';

const DEFAULT_IDLE_MS = 5 * 60_000;
const AUTO_HYGIENE_INTERVAL_MS = 60 * 60_000;
const MAX_FRAME_BUFFER_CHARS = 8 * 1024 * 1024;
const MAX_LEGACY_IMPORT_BYTES = 5 * 1024 * 1024;

interface ParsedArgs {
  projectRoot: string;
  directory?: string | undefined;
}

interface ClientState {
  socket: net.Socket;
  buffer: string;
  active: Map<number, AbortController>;
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
const idleMs =
  Number.isFinite(idleMsInput) && idleMsInput >= 100 ? idleMsInput : DEFAULT_IDLE_MS;
const startedAt = new Date().toISOString();
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
let automaticHygieneInFlight:
  | Promise<SageServerOperations['hygiene']['result']>
  | undefined;

const serverInfo: SageProjectServerInfo = {
  protocolVersion: SAGE_PROJECT_SERVER_PROTOCOL_VERSION,
  pid: process.pid,
  projectRoot,
  storageRoot,
  endpoint,
  startedAt,
};

let resolveReady: (() => void) | undefined;
let rejectReady: ((error: unknown) => void) | undefined;
const ready = new Promise<void>((resolve, reject) => {
  resolveReady = resolve;
  rejectReady = reject;
});

function send(state: ClientState, message: SageProjectServerMessage): void {
  if (!state.socket.destroyed) {
    state.socket.write(encodeSageProjectServerMessage(message));
  }
}

function broadcast(message: SageProjectServerMessage): void {
  for (const state of clients) send(state, message);
}

events.onPattern('memory.*', (event, payload) => {
  broadcast({
    type: 'event',
    event,
    payload,
    meta: requestContext.getStore(),
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
    const resolved = path.resolve(file);
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
    if (
      lastAutomaticHygieneReport &&
      now - lastAutomaticHygieneAt < AUTO_HYGIENE_INTERVAL_MS
    ) {
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
      const fallback = await store.search(
        args.context.currentTask,
        args.scope,
        args.limit,
      );
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
        args.limit === undefined ? undefined : { limit: args.limit },
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

function handleMessage(state: ClientState, message: SageProjectServerClientMessage): void {
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
  void requestContext
    .run(message.meta, () => dispatch(message.op, message.args, controller.signal))
    .then((result) => {
      send(state, { type: 'response', id: message.id, ok: true, result });
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
      state.active.delete(message.id);
      pendingRequests = Math.max(0, pendingRequests - 1);
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
  const temporary = `${metadataPath}.${process.pid}.tmp`;
  await fsPromises.writeFile(temporary, `${JSON.stringify(serverInfo, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  try {
    await fsPromises.rename(temporary, metadataPath);
  } catch {
    await fsPromises.rm(metadataPath, { force: true });
    await fsPromises.rename(temporary, metadataPath);
  }
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
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const state of clients) {
    for (const controller of state.active.values()) {
      controller.abort(new Error('SAGE project server stopping'));
    }
    state.socket.destroy();
  }
  clients.clear();
  await store.dispose().catch(() => {});
  await removeOwnedMetadata();
  if (process.platform !== 'win32') {
    await fsPromises.rm(endpoint, { force: true }).catch(() => {});
  }
}

ensureSageProjectServerSocketDirectory(endpoint);
const server = net.createServer((socket) => {
  if (stopping) {
    socket.destroy();
    return;
  }
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = undefined;
  socket.setEncoding('utf8');
  const state: ClientState = { socket, buffer: '', active: new Map() };
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
});

let probingExistingEndpoint = false;

function listenForOwnership(): void {
  server.listen(endpoint);
}

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE' && process.platform === 'win32') {
    process.exitCode = 0;
    return;
  }
  if (error.code === 'EADDRINUSE' && !probingExistingEndpoint) {
    probingExistingEndpoint = true;
    const probe = net.createConnection(endpoint);
    probe.once('connect', () => {
      probe.destroy();
      process.exitCode = 0;
    });
    probe.once('error', () => {
      probe.destroy();
      try {
        fs.rmSync(endpoint, { force: true });
      } catch {
        // A competing candidate may have already removed the stale endpoint.
      }
      probingExistingEndpoint = false;
      listenForOwnership();
    });
    return;
  }
  rejectReady?.(error);
  process.exitCode = 1;
});

server.on('listening', () => {
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(endpoint, 0o600);
    } catch {
      // Socket-directory mode still restricts access to the current user.
    }
  }
  void store
    .initialize()
    .then(() => writeMetadata())
    .then(() => {
      resolveReady?.();
      scheduleIdleStop();
    })
    .catch((error) => {
      rejectReady?.(error);
      void stop('initialization-failed').finally(() => {
        process.exitCode = 1;
      });
    });
});
listenForOwnership();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void stop(signal).finally(() => {
      process.exitCode = 0;
    });
  });
}
