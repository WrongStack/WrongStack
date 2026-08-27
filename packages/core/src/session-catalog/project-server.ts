#!/usr/bin/env node
import { randomBytes, randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as net from 'node:net';
import * as path from 'node:path';
import { bindProjectEndpoint } from '@wrongstack/persistence';
import { restrictFilePermissions } from '../security/file-permissions.js';
import { atomicWrite } from '../utils/atomic-write.js';
import { useDaemonPerfDefaults } from '../utils/perf-profile.js';
import {
  sessionCatalogProjectServerEndpoint,
  sessionCatalogProjectServerMetadataPath,
} from './endpoint.js';
import {
  encodeSessionCatalogMessage,
  SESSION_CATALOG_MAX_FRAME_CHARS,
  SESSION_CATALOG_PROTOCOL_VERSION,
  type SessionCatalogClientMessage,
  type SessionCatalogEventKind,
  type SessionCatalogMetadata,
  type SessionCatalogOperationName,
  type SessionCatalogOperations,
  type SessionCatalogServerInfo,
  type SessionCatalogServerMessage,
} from './protocol.js';
import { SessionCatalogStore } from './store.js';

interface ParsedArgs {
  projectDir: string;
  projectRoot: string;
}
interface ClientState {
  socket: net.Socket;
  buffer: string;
  subscribed: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (key?.startsWith('--') && argv[index + 1] !== undefined) values.set(key, argv[++index]!);
  }
  const projectDir = values.get('--project-dir');
  const projectRoot = values.get('--project-root');
  if (!projectDir) throw new Error('Session Catalog project server requires --project-dir');
  if (!projectRoot) throw new Error('Session Catalog project server requires --project-root');
  return { projectDir: path.resolve(projectDir), projectRoot: path.resolve(projectRoot) };
}

useDaemonPerfDefaults();
const parsed = parseArgs(process.argv.slice(2));
const endpoint = sessionCatalogProjectServerEndpoint(parsed.projectDir);
const metadataPath = sessionCatalogProjectServerMetadataPath(parsed.projectDir);
const databasePath = path.join(parsed.projectDir, 'sessions', 'catalog.sqlite');
const startedAt = new Date().toISOString();
const instanceId = randomUUID();
const authToken = randomBytes(32).toString('hex');
const idleInput = Number(process.env['WRONGSTACK_SESSION_CATALOG_IDLE_MS']);
const idleMs = Number.isFinite(idleInput) && idleInput >= 100 ? idleInput : 5 * 60_000;
const disconnectedIdleMs = Math.min(idleMs, 250);
const serverInfo: SessionCatalogServerInfo = {
  protocolVersion: SESSION_CATALOG_PROTOCOL_VERSION,
  pid: process.pid,
  projectDir: parsed.projectDir,
  projectRoot: parsed.projectRoot,
  endpoint,
  databasePath,
  instanceId,
  startedAt,
};

process.title = `wrongstack-session-catalog:${path.basename(parsed.projectRoot)}`;
let store: SessionCatalogStore | undefined;
let activeRequests = 0;
let stopping = false;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
const clients = new Set<ClientState>();
const MAX_CLIENTS = 256;
let eventSequence = 0;
let metadataReadyResolve: (() => void) | undefined;
const metadataReady = new Promise<void>((resolve) => {
  metadataReadyResolve = resolve;
});

function send(state: ClientState, message: SessionCatalogServerMessage): void {
  if (state.socket.destroyed) return;
  const encoded = encodeSessionCatalogMessage(message);
  if (
    encoded.length > SESSION_CATALOG_MAX_FRAME_CHARS ||
    state.socket.writableLength + encoded.length > 8 * 1024 * 1024
  ) {
    state.socket.destroy(new Error('Session Catalog client write buffer exceeded'));
    return;
  }
  state.socket.write(encoded);
}

function requiredStore(): SessionCatalogStore {
  if (!store) throw new Error('Session Catalog store is not ready');
  return store;
}

const OPERATION_KEYS: Record<SessionCatalogOperationName, readonly string[]> = {
  ping: [],
  claim_new: ['entry', 'ownerInstanceId', 'leaseMs'],
  reconnect_lease: ['sessionId', 'leaseId', 'leaseSecret', 'ownerInstanceId', 'expiresAt'],
  reserve_resume: ['targetSessionId', 'requesterInstanceId', 'currentSessionId', 'reservationMs'],
  activate_reservation: ['reservation', 'entry', 'leaseMs'],
  cancel_reservation: ['reservationId', 'requesterInstanceId'],
  heartbeat: ['credential', 'status'],
  publish_agents: ['credential', 'revision', 'agents'],
  mark_closing: ['credential'],
  release: ['credential'],
  list_live: [],
  get_live: ['sessionId'],
  subscribe: ['cursor'],
  unsubscribe: [],
  upsert_summary: ['summary', 'transcriptRelativePath', 'summaryRelativePath'],
  list_catalog: [
    'limit',
    'search',
    'since',
    'until',
    'provider',
    'model',
    'minTokens',
    'titleContains',
  ],
  resolve_id: ['query'],
  get_summary: ['sessionId'],
  list_session_agents: ['sessionId'],
  rename: ['sessionId', 'name'],
  acquire_maintenance: ['sessionId', 'operation', 'holderId', 'leaseMs', 'holderPid'],
  release_maintenance: ['lease'],
  delete: ['sessionId', 'lease'],
  prune: ['maxAgeDays', 'holderId'],
  rebuild_catalog: [],
};

function validateOperationArgs(op: string, args: unknown): asserts args is Record<string, unknown> {
  if (!(op in OPERATION_KEYS)) throw new TypeError(`Unknown Session Catalog operation: ${op}`);
  if (!args || typeof args !== 'object' || Array.isArray(args))
    throw new TypeError(`Session Catalog ${op} args must be an object`);
  const allowed = new Set(OPERATION_KEYS[op as SessionCatalogOperationName]);
  const unknown = Object.keys(args).filter((key) => !allowed.has(key));
  if (unknown.length > 0)
    throw new TypeError(`Session Catalog ${op} rejected unknown field(s): ${unknown.join(', ')}`);
  const record = args as Record<string, unknown>;
  const exact = (value: unknown, label: string, keys: readonly string[]): void => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new TypeError(`${label} must be an object`);
    const permitted = new Set(keys);
    const extra = Object.keys(value).filter((key) => !permitted.has(key));
    if (extra.length > 0)
      throw new TypeError(`${label} rejected unknown field(s): ${extra.join(', ')}`);
  };
  const credentialKeys = ['sessionId', 'leaseId', 'leaseSecret', 'ownerInstanceId', 'expiresAt'];
  const reservationKeys = ['reservationId', 'targetSessionId', 'requesterInstanceId', 'expiresAt'];
  const maintenanceKeys = ['sessionId', 'operation', 'holderId', 'leaseId', 'expiresAt'];
  const entryKeys = [
    'sessionId',
    'projectSlug',
    'projectRoot',
    'projectName',
    'workingDir',
    'clientType',
    'gitBranch',
    'status',
    'pid',
    'startedAt',
    'lastHeartbeatAt',
    'agentCount',
    'agents',
    'webuiEndpoint',
  ];
  if (record['credential'] !== undefined)
    exact(record['credential'], `${op}.credential`, credentialKeys);
  if (record['reservation'] !== undefined)
    exact(record['reservation'], `${op}.reservation`, reservationKeys);
  if (record['lease'] !== undefined) exact(record['lease'], `${op}.lease`, maintenanceKeys);
  if (record['entry'] !== undefined) exact(record['entry'], `${op}.entry`, entryKeys);
  if (record['entry'] && typeof record['entry'] === 'object') {
    const entry = record['entry'] as Record<string, unknown>;
    if (
      typeof entry['projectRoot'] !== 'string' ||
      (process.platform === 'win32'
        ? path.resolve(entry['projectRoot']).toLowerCase() !== parsed.projectRoot.toLowerCase()
        : path.resolve(entry['projectRoot']) !== parsed.projectRoot)
    ) {
      throw new TypeError(`${op}.entry project identity does not match this daemon`);
    }
    if (typeof entry['workingDir'] !== 'string')
      throw new TypeError(`${op}.entry workingDir is required`);
    const relative = path.relative(parsed.projectRoot, path.resolve(entry['workingDir']));
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new TypeError(`${op}.entry workingDir is outside the project root`);
    }
  }
}

async function dispatch<O extends SessionCatalogOperationName>(
  op: O,
  args: SessionCatalogOperations[O]['args'],
): Promise<SessionCatalogOperations[O]['result']> {
  const catalog = requiredStore();
  switch (op) {
    case 'ping': {
      const memory = process.memoryUsage();
      const handles =
        (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles?.()
          .length ?? 0;
      return catalog.health({
        ...serverInfo,
        checkedAt: Date.now(),
        uptimeMs: Date.now() - Date.parse(startedAt),
        clients: clients.size,
        activeRequests,
        memory,
        handles,
      }) as SessionCatalogOperations[O]['result'];
    }
    case 'claim_new': {
      const value = args as SessionCatalogOperations['claim_new']['args'];
      return catalog.claimNew(
        value.entry,
        value.ownerInstanceId,
        value.leaseMs,
      ) as SessionCatalogOperations[O]['result'];
    }
    case 'reconnect_lease':
      return catalog.reconnectLease(
        args as SessionCatalogOperations['reconnect_lease']['args'],
      ) as SessionCatalogOperations[O]['result'];
    case 'reserve_resume': {
      const value = args as SessionCatalogOperations['reserve_resume']['args'];
      return catalog.reserveResume(
        value.targetSessionId,
        value.requesterInstanceId,
        value.currentSessionId,
        value.reservationMs,
      ) as SessionCatalogOperations[O]['result'];
    }
    case 'activate_reservation': {
      const value = args as SessionCatalogOperations['activate_reservation']['args'];
      return catalog.activateReservation(
        value.reservation,
        value.entry,
        value.leaseMs,
      ) as SessionCatalogOperations[O]['result'];
    }
    case 'cancel_reservation': {
      const value = args as SessionCatalogOperations['cancel_reservation']['args'];
      catalog.cancelReservation(value.reservationId, value.requesterInstanceId);
      return undefined as SessionCatalogOperations[O]['result'];
    }
    case 'heartbeat': {
      const value = args as SessionCatalogOperations['heartbeat']['args'];
      return catalog.heartbeat(
        value.credential,
        value.status,
      ) as SessionCatalogOperations[O]['result'];
    }
    case 'publish_agents': {
      const value = args as SessionCatalogOperations['publish_agents']['args'];
      return catalog.publishAgents(
        value.credential,
        value.revision,
        value.agents,
      ) as SessionCatalogOperations[O]['result'];
    }
    case 'mark_closing': {
      catalog.markClosing((args as SessionCatalogOperations['mark_closing']['args']).credential);
      return undefined as SessionCatalogOperations[O]['result'];
    }
    case 'release': {
      catalog.release((args as SessionCatalogOperations['release']['args']).credential);
      return undefined as SessionCatalogOperations[O]['result'];
    }
    case 'list_live':
      return catalog.listLive() as SessionCatalogOperations[O]['result'];
    case 'get_live':
      return catalog.getLive(
        (args as SessionCatalogOperations['get_live']['args']).sessionId,
      ) as SessionCatalogOperations[O]['result'];
    case 'subscribe':
      return { instanceId, sequence: eventSequence } as SessionCatalogOperations[O]['result'];
    case 'unsubscribe':
      return undefined as SessionCatalogOperations[O]['result'];
    case 'upsert_summary': {
      const value = args as SessionCatalogOperations['upsert_summary']['args'];
      return catalog.upsertSummary(
        value.summary,
        value.transcriptRelativePath,
        value.summaryRelativePath,
      ) as SessionCatalogOperations[O]['result'];
    }
    case 'list_catalog': {
      const value = args as SessionCatalogOperations['list_catalog']['args'];
      return catalog.listCatalog(value) as SessionCatalogOperations[O]['result'];
    }
    case 'resolve_id':
      return catalog.resolveId(
        (args as SessionCatalogOperations['resolve_id']['args']).query,
      ) as SessionCatalogOperations[O]['result'];
    case 'get_summary':
      return catalog.getSummary(
        (args as SessionCatalogOperations['get_summary']['args']).sessionId,
      ) as SessionCatalogOperations[O]['result'];
    case 'rename': {
      const value = args as SessionCatalogOperations['rename']['args'];
      return (await catalog.rename(
        value.sessionId,
        value.name,
      )) as SessionCatalogOperations[O]['result'];
    }
    case 'acquire_maintenance': {
      const value = args as SessionCatalogOperations['acquire_maintenance']['args'];
      return catalog.acquireMaintenance(
        value.sessionId,
        value.operation,
        value.holderId,
        value.leaseMs,
        value.holderPid,
      ) as SessionCatalogOperations[O]['result'];
    }
    case 'release_maintenance': {
      catalog.releaseMaintenance(
        (args as SessionCatalogOperations['release_maintenance']['args']).lease,
      );
      return undefined as SessionCatalogOperations[O]['result'];
    }
    case 'delete': {
      const value = args as SessionCatalogOperations['delete']['args'];
      catalog.delete(value.sessionId, value.lease);
      return undefined as SessionCatalogOperations[O]['result'];
    }
    case 'prune': {
      const value = args as SessionCatalogOperations['prune']['args'];
      return catalog.prune(
        value.maxAgeDays,
        value.holderId,
      ) as SessionCatalogOperations[O]['result'];
    }
    case 'list_session_agents': {
      const value = args as SessionCatalogOperations['list_session_agents']['args'];
      return catalog.listSessionAgents(value.sessionId) as SessionCatalogOperations[O]['result'];
    }
    case 'rebuild_catalog':
      return catalog.rebuildCatalog() as SessionCatalogOperations[O]['result'];
    default:
      throw new Error(`Unsupported Session Catalog operation: ${String(op)}`);
  }
}

function emitEvent(kind: SessionCatalogEventKind, sessionId?: string): void {
  const event = {
    instanceId,
    sequence: ++eventSequence,
    kind,
    ...(sessionId ? { sessionId } : {}),
    generation: requiredStore().generation(),
    at: new Date().toISOString(),
  };
  for (const client of clients) {
    if (client.subscribed) send(client, { type: 'event', event });
  }
}

function eventForOperation(op: SessionCatalogOperationName): SessionCatalogEventKind | undefined {
  switch (op) {
    case 'claim_new':
    case 'activate_reservation':
      return 'session.claimed';
    case 'publish_agents':
      return 'session.presence_changed';
    case 'mark_closing':
      return 'session.closing';
    case 'release':
      return 'session.released';
    case 'upsert_summary':
    case 'rename':
      return 'session.catalog_changed';
    case 'delete':
      return 'session.deleted';
    case 'rebuild_catalog':
      return 'session.rebuild_completed';
    default:
      return undefined;
  }
}

async function handleMessage(
  state: ClientState,
  message: SessionCatalogClientMessage,
): Promise<void> {
  if (!message || typeof message !== 'object' || !Number.isSafeInteger(message.id)) {
    state.socket.destroy(new Error('Invalid Session Catalog request'));
    return;
  }
  if (message.authToken !== authToken) {
    send(state, {
      type: 'response',
      id: message.id,
      ok: false,
      error: 'Unauthorized Session Catalog request',
      errorName: 'UnauthorizedSessionCatalogRequest',
    });
    return;
  }
  if (message.type === 'shutdown') {
    send(state, {
      type: 'response',
      id: message.id,
      ok: true,
      result: { stopped: true, pid: process.pid },
    });
    setImmediate(() => void stop(message.reason ?? 'client shutdown'));
    return;
  }
  if (message.type !== 'request' || typeof message.op !== 'string') {
    state.socket.destroy(new Error('Invalid Session Catalog request'));
    return;
  }
  activeRequests++;
  try {
    validateOperationArgs(message.op, message.args);
    if (message.op === 'subscribe') state.subscribed = true;
    if (message.op === 'unsubscribe') state.subscribed = false;
    if (message.op === 'rebuild_catalog') emitEvent('session.rebuild_started');
    const result = await dispatch(message.op, message.args as never);
    send(state, { type: 'response', id: message.id, ok: true, result });
    const eventKind = eventForOperation(message.op);
    if (eventKind) {
      const args = message.args as Record<string, unknown>;
      const nested = args['entry'] as { sessionId?: unknown } | undefined;
      const sessionId =
        typeof args['sessionId'] === 'string'
          ? args['sessionId']
          : typeof nested?.sessionId === 'string'
            ? nested.sessionId
            : undefined;
      emitEvent(eventKind, sessionId);
    }
  } catch (error) {
    send(state, {
      type: 'response',
      id: message.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      ...(error instanceof Error && error.name ? { errorName: error.name } : {}),
    });
  } finally {
    activeRequests--;
    scheduleIdleStop();
  }
}

function onData(state: ClientState, chunk: string): void {
  state.buffer += chunk;
  if (state.buffer.length > SESSION_CATALOG_MAX_FRAME_CHARS) {
    state.socket.destroy(new Error('Session Catalog request exceeded frame limit'));
    return;
  }
  while (true) {
    const newline = state.buffer.indexOf('\n');
    if (newline < 0) return;
    const line = state.buffer.slice(0, newline);
    state.buffer = state.buffer.slice(newline + 1);
    if (!line) continue;
    try {
      void handleMessage(state, JSON.parse(line) as SessionCatalogClientMessage);
    } catch {
      state.socket.destroy(new Error('Invalid Session Catalog request'));
      return;
    }
  }
}

function scheduleIdleStop(emptyIdleMs = idleMs): void {
  if (stopping || clients.size > 0 || activeRequests > 0 || idleTimer) return;
  const hasLiveLease = requiredStore().listLive().length > 0;
  idleTimer = setTimeout(
    () => {
      idleTimer = undefined;
      if (requiredStore().listLive().length > 0) scheduleIdleStop(emptyIdleMs);
      else void stop('idle timeout');
    },
    hasLiveLease ? 5_000 : emptyIdleMs,
  );
  idleTimer.unref?.();
}

async function writeMetadata(): Promise<void> {
  await fsp.mkdir(parsed.projectDir, { recursive: true, mode: 0o700 });
  const metadata: SessionCatalogMetadata = { ...serverInfo, authToken };
  await atomicWrite(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
  await restrictFilePermissions(metadataPath, { label: 'session-catalog-metadata' });
}

async function removeOwnedMetadata(): Promise<void> {
  try {
    const current = JSON.parse(await fsp.readFile(metadataPath, 'utf8')) as {
      pid?: number;
      instanceId?: string;
    };
    if (current.pid === process.pid && current.instanceId === instanceId)
      await fsp.rm(metadataPath, { force: true });
  } catch {
    /* missing or replaced */
  }
}

async function stop(_reason: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  if (idleTimer) clearTimeout(idleTimer);
  for (const state of clients) state.socket.destroy();
  clients.clear();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  store?.close();
  store = undefined;
  if (process.platform !== 'win32') await fsp.rm(endpoint, { force: true }).catch(() => undefined);
  // Metadata disappearance is the shutdown completion signal for clients.
  // Remove it only after SQLite and the listening endpoint have closed.
  await removeOwnedMetadata();
}

const server = net.createServer((socket) => {
  if (stopping) {
    socket.destroy();
    return;
  }
  if (clients.size >= MAX_CLIENTS) {
    socket.destroy();
    return;
  }
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = undefined;
  socket.setEncoding('utf8');
  const state: ClientState = { socket, buffer: '', subscribed: false };
  clients.add(state);
  void metadataReady.then(() => {
    if (!socket.destroyed) send(state, { type: 'hello', ...serverInfo });
  });
  socket.on('data', (chunk: string) => onData(state, chunk));
  socket.on('close', () => {
    clients.delete(state);
    // Once the last client leaves and no live lease remains, this process no
    // longer represents an active project. Keep only a tiny disconnect grace
    // for socket churn; the longer startup idle window applies before the
    // first client connects.
    scheduleIdleStop(disconnectedIdleMs);
  });
});

// The bind is the ownership election, including the probe-then-reclaim ladder
// for an endpoint whose owner died without cleanup. Shared with every other
// project daemon via `bindProjectEndpoint`.
void (async () => {
  const bind = await bindProjectEndpoint({ server, endpoint, service: 'session-catalog' });
  if (bind.outcome === 'already-owned') {
    process.exitCode = 0;
    return;
  }
  if (bind.outcome === 'failed') {
    process.stderr.write(`session-catalog project server failed: ${bind.error.message}\n`);
    process.exitCode = 1;
    return;
  }
  if (bind.reclaimedStaleEndpoint) {
    process.stderr.write(`session-catalog project server reclaimed stale endpoint ${endpoint}\n`);
  }
  server.on('error', (error: NodeJS.ErrnoException) => {
    if (stopping) return;
    process.stderr.write(`session-catalog project server error: ${error.message}\n`);
    process.exitCode = 1;
  });
  try {
    store = new SessionCatalogStore(parsed.projectDir);
    void writeMetadata()
      .then(() => metadataReadyResolve?.())
      .catch(() => void stop('metadata write failed'));
  } catch {
    void stop('catalog open failed');
    return;
  }
  scheduleIdleStop();
})();
process.once('SIGINT', () => void stop('SIGINT'));
process.once('SIGTERM', () => void stop('SIGTERM'));
