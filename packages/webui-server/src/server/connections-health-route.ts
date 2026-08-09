import * as net from 'node:net';
import {
  ChronicleProjectServerClient,
  createChronicleProjectAccess,
  resolveChronicleProjectServerOptions,
} from '@wrongstack/core/chronicle';
import {
  isMailboxProjectServerAvailable,
  MailboxProjectServerConnection,
} from '@wrongstack/core/coordination';
import type { TrustBoundary } from '@wrongstack/core/security';
import { SessionCatalogProjectClient } from '@wrongstack/core/session-catalog';
import { resolveWstackPaths } from '@wrongstack/core/utils';
import {
  closeKanbanServerConnections,
  getKanbanServerConnection,
  isKanbanServerAvailable,
} from '@wrongstack/kanban';
import { readGovernanceDaemonOperatorStatus } from '@wrongstack/runtime/governance-bootstrap';
import { isSageProjectServerAvailable, SageProjectServerConnection } from '@wrongstack/sage';
import {
  checkCodebaseIndexServerHealth,
  ensureCodebaseIndexServer,
  getIndexState,
  resolveProjectIndexDaemonAvailability,
  shutdownCodebaseIndexServer,
} from '@wrongstack/tools';
import type { WebSocket } from 'ws';
import { authorizeWebUIAction } from './privileged-actions.js';
import type { WSClientMessage, WSServerMessage } from './types.js';

export type ConnectionHealthStatus = 'healthy' | 'degraded' | 'offline' | 'unavailable' | 'error';

export interface ConnectionHealthService {
  id:
    | 'webui'
    | 'session-catalog'
    | 'chronicle'
    | 'codebase-index'
    | 'sage'
    | 'kanban'
    | 'mailbox'
    | 'governance';
  label: string;
  status: ConnectionHealthStatus;
  required: boolean;
  mode: string;
  detail: string;
  ownerPid?: number | undefined;
  endpoint?: string | undefined;
  storage?: string | undefined;
  uptimeMs?: number | undefined;
  latencyMs?: number | undefined;
  clients?: number | undefined;
  activeRequests?: number | undefined;
  queuedWork?: number | undefined;
  watcher?: { active: boolean; watchedFiles?: number | undefined } | undefined;
  lastError?: string | undefined;
  control?: 'shutdown' | 'none' | undefined;
  advisory?:
    | {
        code: string;
        operatorAction: 'none' | 'observe' | 'investigate';
        executionDisposition: 'continue';
      }
    | undefined;
}

export interface ConnectionsHealthReport {
  checkedAt: number;
  overall: 'healthy' | 'degraded' | 'error';
  backend: 'standalone' | 'cli-embedded';
  projectRoot: string;
  services: ConnectionHealthService[];
}

export interface ConnectionsHealthContext {
  getProjectRoot(): string;
  getIndexDir(): string | undefined;
  send(ws: WebSocket, message: WSServerMessage): void;
  backend: ConnectionsHealthReport['backend'];
  collect?: (() => Promise<ConnectionsHealthReport>) | undefined;
  /**
   * Policy authority for `connections.service_action`. Optional so the
   * read-only `connections.health` route keeps working without one, but the
   * action route REFUSES when it is absent rather than proceeding unchecked —
   * a missing boundary must not read as "allowed".
   */
  trustBoundary?: TrustBoundary | undefined;
  logger?: Parameters<typeof authorizeWebUIAction>[2];
}

/** One read-only health report for every per-project backend connection. */
export async function handleConnectionsHealthRoute(
  context: ConnectionsHealthContext,
  ws: WebSocket,
  message: WSClientMessage,
): Promise<boolean> {
  if (message.type !== 'connections.health') return false;
  try {
    const report =
      (await context.collect?.()) ??
      (await collectConnectionsHealth({
        projectRoot: context.getProjectRoot(),
        indexDir: context.getIndexDir(),
        backend: context.backend,
      }));
    context.send(ws, { type: 'connections.health_result', payload: report });
  } catch (error) {
    context.send(ws, {
      type: 'connections.health_error',
      payload: { message: error instanceof Error ? error.message : String(error) },
    });
  }
  return true;
}

export async function collectConnectionsHealth(options: {
  projectRoot: string;
  indexDir?: string | undefined;
  backend: ConnectionsHealthReport['backend'];
}): Promise<ConnectionsHealthReport> {
  const services = await Promise.all([
    Promise.resolve(webuiHealth(options.backend)),
    sessionCatalogHealth(options.projectRoot),
    chronicleHealth(options.projectRoot),
    codebaseIndexHealth(options.projectRoot, options.indexDir),
    sageHealth(options.projectRoot),
    kanbanHealth(options.projectRoot),
    mailboxHealth(options.projectRoot),
    governanceHealth(options.projectRoot),
  ]);
  const required = services.filter((service) => service.required);
  const overall = required.some((service) => service.status === 'error')
    ? 'error'
    : required.some((service) => service.status !== 'healthy')
      ? 'degraded'
      : 'healthy';
  return {
    checkedAt: Date.now(),
    overall,
    backend: options.backend,
    projectRoot: options.projectRoot,
    services,
  };
}

async function sessionCatalogHealth(projectRoot: string): Promise<ConnectionHealthService> {
  const startedAt = Date.now();
  try {
    const paths = resolveWstackPaths({ projectRoot });
    const client = new SessionCatalogProjectClient({
      projectDir: paths.projectDir,
      projectRoot,
    });
    try {
      const health = await client.ping();
      return {
        id: 'session-catalog',
        label: 'Session Catalog',
        status: health.damagedRows > 0 ? 'degraded' : 'healthy',
        required: true,
        mode: 'project-daemon',
        detail:
          health.damagedRows > 0
            ? `${health.damagedRows} damaged catalog row(s); rebuild is required.`
            : `${health.catalogRows} catalog session(s), ${health.liveLeases} live lease(s), ${health.reservations} reservation(s).`,
        ownerPid: health.pid,
        endpoint: health.endpoint,
        storage: health.databasePath,
        uptimeMs: health.uptimeMs,
        latencyMs: Date.now() - startedAt,
        clients: health.clients,
        activeRequests: health.activeRequests,
        queuedWork: health.reservations + health.maintenanceLeases,
        control: 'none',
      };
    } finally {
      await client.close().catch(() => undefined);
    }
  } catch (error) {
    return {
      id: 'session-catalog',
      label: 'Session Catalog',
      status: 'error',
      required: true,
      mode: 'project-daemon',
      detail: 'Project-scoped session ownership and catalog are unavailable.',
      latencyMs: Date.now() - startedAt,
      lastError: error instanceof Error ? error.message : String(error),
      control: 'none',
    };
  }
}

function webuiHealth(backend: ConnectionsHealthReport['backend']): ConnectionHealthService {
  return {
    id: 'webui',
    label: 'WebUI transport',
    status: 'healthy',
    required: true,
    mode: backend,
    detail: 'This browser is connected to the WebUI WebSocket backend.',
    ownerPid: process.pid,
  };
}

async function chronicleHealth(projectRoot: string): Promise<ConnectionHealthService> {
  const startedAt = Date.now();
  let access: ReturnType<typeof createChronicleProjectAccess> | undefined;
  try {
    access = createChronicleProjectAccess({ projectRoot });
    const health = await access.call('ping', {}, { timeoutMs: 5_000 });
    const quarantined = health.quarantinedFamilies ?? [];
    return {
      id: 'chronicle',
      label: 'Chronicle telemetry',
      status:
        quarantined.length > 0 ? 'degraded' : access.mode === 'server' ? 'healthy' : 'degraded',
      required: true,
      mode: access.mode,
      detail:
        quarantined.length > 0
          ? `Serving, but ${quarantined.length} day(s) were quarantined for a broken chain: ${quarantined
              .map((family) => family.day)
              .join(', ')}.`
          : access.mode === 'server'
            ? 'One project owner collects, processes, stores, and serves telemetry.'
            : 'Inline fallback is active; ownership is not shared across clients.',
      ownerPid: health.pid,
      endpoint: health.endpoint,
      storage: health.chronicleDirectory,
      uptimeMs: health.uptimeMs,
      latencyMs: Date.now() - startedAt,
      clients: health.clients,
      activeRequests: health.activeRequests,
      queuedWork: health.journal.pendingEvents,
      watcher: {
        active: health.watcher.active,
        watchedFiles: health.watcher.watchedFiles,
      },
      ...(quarantined[0]
        ? { lastError: quarantined[0].reason }
        : health.watcher.lastError
          ? { lastError: health.watcher.lastError }
          : {}),
    };
  } catch (error) {
    return failureService(
      'chronicle',
      'Chronicle telemetry',
      true,
      access?.mode ?? 'unavailable',
      error,
      Date.now() - startedAt,
    );
  } finally {
    await access?.close();
  }
}

async function codebaseIndexHealth(
  projectRoot: string,
  indexDir?: string,
): Promise<ConnectionHealthService> {
  const startedAt = Date.now();
  const availability = resolveProjectIndexDaemonAvailability(projectRoot, indexDir);
  if (availability.kind === 'endpoint-invalid') {
    return {
      id: 'codebase-index',
      label: 'Codebase index',
      status: 'unavailable',
      required: false,
      mode: 'endpoint-invalid',
      detail:
        `Socket path is ${availability.byteLength} bytes — over this platform's ` +
        `${availability.maxBytes}-byte sun_path limit. Queries fall back to a process-local ` +
        `index. Set a shorter TMPDIR to restore the shared daemon.`,
      endpoint: availability.endpoint,
      latencyMs: Date.now() - startedAt,
    };
  }
  try {
    const health = await checkCodebaseIndexServerHealth(projectRoot, indexDir, {
      timeoutMs: 2_000,
    });
    const connection = getIndexState().server;
    return {
      id: 'codebase-index',
      label: 'Codebase index',
      status: health.status === 'unresponsive' ? 'error' : health.status,
      required: false,
      mode: 'project-server',
      detail: health.server?.activity.indexing
        ? `Indexing ${health.server.activity.currentFile}/${health.server.activity.totalFiles}.`
        : 'Shared symbol index is ready for project queries.',
      ownerPid: connection.pid,
      endpoint: connection.endpoint,
      storage:
        connection.indexDir ?? indexDir ?? resolveWstackPaths({ projectRoot }).projectCodebaseIndex,
      uptimeMs: health.server?.uptimeMs,
      latencyMs: health.latencyMs ?? Date.now() - startedAt,
      clients: health.server?.clients,
      activeRequests: health.server?.activeRequests,
      queuedWork: health.server?.queuedWrites,
      watcher: health.server
        ? { active: health.server.watchingExternal, watchedFiles: health.server.watchingClients }
        : undefined,
    };
  } catch (error) {
    if (!isOfflineConnectionError(error)) {
      return failureService(
        'codebase-index',
        'Codebase index',
        false,
        'project-server',
        error,
        Date.now() - startedAt,
      );
    }
    return {
      ...failureService(
        'codebase-index',
        'Codebase index',
        false,
        'on-demand project-server',
        error,
        Date.now() - startedAt,
      ),
      status: 'offline',
      detail: 'Not running for this project; it starts on demand when indexing is used.',
    };
  }
}

async function sageHealth(projectRoot: string): Promise<ConnectionHealthService> {
  const startedAt = Date.now();
  if (!isSageProjectServerAvailable()) {
    return {
      id: 'sage',
      label: 'SAGE memory',
      status: 'unavailable',
      required: false,
      mode: 'unavailable',
      detail: 'The packaged SAGE project server is unavailable in this runtime.',
    };
  }
  const connection = new SageProjectServerConnection(projectRoot);
  try {
    const status = await connection.status();
    if (!status) {
      return {
        id: 'sage',
        label: 'SAGE memory',
        status: 'offline',
        required: false,
        mode: 'on-demand project-server',
        detail: 'Not running for this project; it starts on demand when memory is used.',
        endpoint: connection.getState().endpoint,
        latencyMs: Date.now() - startedAt,
      };
    }
    const healthStatus =
      status.health.status === 'ready'
        ? 'healthy'
        : status.health.status === 'degraded'
          ? 'degraded'
          : 'error';
    return {
      id: 'sage',
      label: 'SAGE memory',
      status: healthStatus,
      required: false,
      mode: 'project-server',
      detail: `Persistent project memory backend: ${status.health.backend}.`,
      ownerPid: status.pid,
      endpoint: status.endpoint,
      storage: status.storageRoot,
      latencyMs: Date.now() - startedAt,
      clients: status.clients,
      activeRequests: status.pendingRequests,
    };
  } catch (error) {
    return failureService(
      'sage',
      'SAGE memory',
      false,
      'project-server',
      error,
      Date.now() - startedAt,
    );
  } finally {
    connection.close();
  }
}

async function kanbanHealth(projectRoot: string): Promise<ConnectionHealthService> {
  const startedAt = Date.now();
  if (process.env['WRONGSTACK_KANBAN_SERVER'] === '0') {
    return {
      id: 'kanban',
      label: 'Kanban IPC',
      status: 'unavailable',
      required: false,
      mode: 'disabled',
      detail: 'Kanban IPC daemon is disabled via WRONGSTACK_KANBAN_SERVER=0.',
    };
  }
  let connection;
  try {
    connection = await getKanbanServerConnection(projectRoot);
  } catch (error) {
    return failureService(
      'kanban',
      'Kanban IPC',
      false,
      'project-server',
      error,
      Date.now() - startedAt,
    );
  }
  if (!connection) {
    return {
      id: 'kanban',
      label: 'Kanban IPC',
      status: 'unavailable',
      required: false,
      mode: 'disabled',
      detail: 'Kanban IPC daemon is disabled in this runtime.',
    };
  }
  try {
    const status = await connection.request('ping', {}, { timeoutMs: 5_000 });
    return {
      id: 'kanban',
      label: 'Kanban IPC',
      status: 'healthy',
      required: true,
      mode: 'project-server',
      detail: `Single shared project-server owns kanban state for this project (v${status.protocolVersion}).`,
      ownerPid: status.pid,
      endpoint: status.endpoint,
      storage: status.databasePath,
      latencyMs: Date.now() - startedAt,
      clients: status.clients,
      activeRequests: status.pendingRequests,
      uptimeMs: Date.now() - new Date(status.startedAt).getTime(),
    };
  } catch (error) {
    return failureService(
      'kanban',
      'Kanban IPC',
      true,
      'project-server',
      error,
      Date.now() - startedAt,
    );
  }
}

function isOfflineConnectionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:ENOENT|ECONNREFUSED|not found|not running|unavailable|connect failed)/iu.test(message);
}

async function mailboxHealth(projectRoot: string): Promise<ConnectionHealthService> {
  const startedAt = Date.now();
  if (!isMailboxProjectServerAvailable()) {
    return {
      id: 'mailbox',
      label: 'Mailbox IPC',
      status: 'unavailable',
      required: false,
      mode: 'unavailable',
      detail: 'The packaged mailbox project server is unavailable in this runtime.',
    };
  }
  // The mailbox owner keys its pipe on the *data* directory, not the repo root
  // — unlike SAGE and kanban, which take the root. Passing the root here
  // derived a different pipe name than the running daemon, so a healthy owner
  // with live clients was reported as "sleeping" on every refresh.
  const connection = new MailboxProjectServerConnection(
    resolveWstackPaths({ projectRoot }).projectDir,
  );
  try {
    const status = await connection.probeStatus();
    if (!status) {
      return {
        id: 'mailbox',
        label: 'Mailbox IPC',
        status: 'offline',
        required: false,
        mode: 'on-demand project-server',
        detail: 'Not running for this project; it starts on demand when mailbox is used.',
        endpoint: connection.getState().endpoint,
        latencyMs: Date.now() - startedAt,
      };
    }
    return {
      id: 'mailbox',
      label: 'Mailbox IPC',
      status: 'healthy',
      required: true,
      mode: 'project-server',
      detail: `Single shared project-server owns inter-agent mailbox state for this project (v${status.protocolVersion}).`,
      ownerPid: status.pid,
      endpoint: status.endpoint,
      storage: status.databasePath,
      latencyMs: Date.now() - startedAt,
      clients: status.clients,
      activeRequests: status.pendingRequests,
      uptimeMs: Date.now() - new Date(status.startedAt).getTime(),
    };
  } catch (error) {
    return failureService(
      'mailbox',
      'Mailbox IPC',
      true,
      'project-server',
      error,
      Date.now() - startedAt,
    );
  } finally {
    connection.close();
  }
}

async function governanceHealth(projectRoot: string): Promise<ConnectionHealthService> {
  const startedAt = Date.now();
  const result = await readGovernanceDaemonOperatorStatus(projectRoot);
  if (!result.available) {
    const missing = result.code === 'broker_missing';
    return {
      id: 'governance',
      label: 'Governance control plane',
      status: missing ? 'offline' : 'error',
      required: false,
      mode: missing ? 'compatibility-default-off' : 'project-daemon',
      detail: missing
        ? 'Not active for this project. Existing agent and model execution remains unchanged.'
        : `Read-only governance status is unavailable: ${result.message}`,
      latencyMs: Date.now() - startedAt,
      control: 'none',
      ...(missing ? {} : { lastError: result.message }),
    };
  }
  const { status } = result;
  return {
    id: 'governance',
    label: 'Governance control plane',
    status: status.signal.level === 'healthy' ? 'healthy' : 'degraded',
    required: false,
    mode: 'project-daemon-advisory',
    detail: `${status.signal.message} Execution continues; no automatic task or model stop.`,
    ownerPid: status.pid,
    uptimeMs: Math.max(0, Date.now() - Date.parse(status.startedAt)),
    latencyMs: Date.now() - startedAt,
    control: 'none',
    advisory: {
      code: status.signal.code,
      operatorAction: status.signal.operatorAction,
      executionDisposition: status.signal.executionDisposition,
    },
  };
}

// ── Service action (reset/kill) ──────────────────────────────────────────────

export interface ServiceActionResult {
  serviceId: ConnectionHealthService['id'] | null;
  action: 'shutdown' | 'restart';
  success: boolean;
  message: string;
}

/** Handle WS message type `connections.service_action` — reset or kill a service. */
export async function handleConnectionsServiceAction(
  ws: WebSocket,
  message: WSClientMessage,
  context: ConnectionsHealthContext,
): Promise<boolean> {
  if (message.type !== 'connections.service_action') return false;

  const payload = message.payload as { serviceId?: string; action?: string } | undefined;
  const serviceId = payload?.serviceId;
  const rawAction = payload?.action ?? 'shutdown';

  if (!serviceId) {
    context.send(ws, {
      type: 'connections.service_action_result',
      payload: {
        serviceId: null,
        action: rawAction as 'shutdown' | 'restart',
        success: false,
        message: 'Missing serviceId in payload',
      } satisfies ServiceActionResult,
    });
    return true;
  }

  if (rawAction !== 'shutdown' && rawAction !== 'restart') {
    context.send(ws, {
      type: 'connections.service_action_result',
      payload: {
        serviceId: serviceId as ConnectionHealthService['id'],
        action: rawAction as 'shutdown' | 'restart',
        success: false,
        message: `Unsupported action "${rawAction}" — only "shutdown" and "restart" are supported`,
      } satisfies ServiceActionResult,
    });
    return true;
  }

  const action = rawAction;

  // Trust boundary. This route kills per-project daemons — kanban, sage,
  // chronicle, codebase-index, mailbox — and `restart` additionally SPAWNS
  // them, yet it was the one privileged route in the package that never asked.
  // `authorizeWebUIAction` is opt-in per handler and seven files call it; this
  // one, the most destructive, did not. A deployment could deny
  // `codebase-index.server.shutdown` (checked by
  // codebase-index-server-control.ts:32) and still have the same client kill
  // the same server through here, with no audit record.
  if (!context.trustBoundary) {
    context.send(ws, {
      type: 'connections.service_action_result',
      payload: {
        serviceId: serviceId as ConnectionHealthService['id'],
        action: action as 'shutdown' | 'restart',
        success: false,
        message: 'Service control is unavailable: no policy authority is configured.',
      } satisfies ServiceActionResult,
    });
    return true;
  }
  const projectRootForAuth = context.getProjectRoot();
  const authorization = await authorizeWebUIAction(
    context.trustBoundary,
    {
      capability: `connections.service.${action}`,
      subject: { kind: 'process', id: `${serviceId}@${projectRootForAuth}` },
      risk: 'elevated',
      cwd: projectRootForAuth,
      metadata: { transport: 'websocket', serviceId, action },
    },
    context.logger,
  );
  if (!authorization.allowed) {
    context.send(ws, {
      type: 'connections.service_action_result',
      payload: {
        serviceId: serviceId as ConnectionHealthService['id'],
        action: action as 'shutdown' | 'restart',
        success: false,
        message: authorization.reason ?? 'Refused by policy.',
      } satisfies ServiceActionResult,
    });
    return true;
  }

  // 'webui' cannot kill itself
  if (serviceId === 'webui') {
    context.send(ws, {
      type: 'connections.service_action_result',
      payload: {
        serviceId: 'webui',
        action: action as 'shutdown' | 'restart',
        success: false,
        message:
          action === 'restart'
            ? 'Cannot restart the WebUI transport itself'
            : 'Cannot shut down the WebUI transport itself',
      } satisfies ServiceActionResult,
    });
    return true;
  }

  try {
    const result = await executeServiceAction(
      serviceId as ConnectionHealthService['id'],
      action as 'shutdown' | 'restart',
      context.getProjectRoot(),
      context.getIndexDir(),
    );
    context.send(ws, {
      type: 'connections.service_action_result',
      payload: result satisfies ServiceActionResult,
    });
  } catch (error) {
    context.send(ws, {
      type: 'connections.service_action_result',
      payload: {
        serviceId: serviceId as ConnectionHealthService['id'],
        action: action as 'shutdown' | 'restart',
        success: false,
        message: error instanceof Error ? error.message : String(error),
      } satisfies ServiceActionResult,
    });
  }
  return true;
}

async function executeServiceAction(
  serviceId: ConnectionHealthService['id'],
  action: 'shutdown' | 'restart',
  projectRoot: string,
  indexDir: string | undefined,
): Promise<ServiceActionResult> {
  switch (serviceId) {
    case 'kanban':
      return killKanbanServer(projectRoot, action);
    case 'sage':
      return killSageServer(projectRoot, action);
    case 'chronicle':
      return killChronicleServer(projectRoot, action);
    case 'codebase-index':
      return killCodebaseIndexServer(projectRoot, indexDir, action);
    case 'mailbox':
      return killMailboxServer(projectRoot, action);
    case 'governance':
      return {
        serviceId: 'governance',
        action,
        success: false,
        message:
          'Governance health is read-only; daemon shutdown requires a separate admin control capability.',
      };
    default:
      return {
        serviceId: serviceId as ConnectionHealthService['id'],
        action,
        success: false,
        message: `Unknown service: ${serviceId}`,
      };
  }
}

async function killKanbanServer(
  projectRoot: string,
  action: 'shutdown' | 'restart',
): Promise<ServiceActionResult> {
  if (process.env['WRONGSTACK_KANBAN_SERVER'] === '0') {
    return {
      serviceId: 'kanban',
      action,
      success: false,
      message: 'Kanban IPC daemon is disabled via WRONGSTACK_KANBAN_SERVER=0',
    };
  }
  let connection;
  try {
    connection = await getKanbanServerConnection(projectRoot);
  } catch (error) {
    return {
      serviceId: 'kanban',
      action,
      success: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  if (!connection) {
    return {
      serviceId: 'kanban',
      action,
      success: false,
      message: 'Kanban IPC daemon is not running',
    };
  }
  try {
    const result = await connection.request('shutdown', {
      reason: `WebUI request: ${action}`,
    });
    if (!result.stopping) {
      return {
        serviceId: 'kanban',
        action,
        success: false,
        message: 'Kanban IPC daemon shutdown failed (not confirmed)',
      };
    }
    if (action === 'restart') {
      // Evict the stale cached connection so getKanbanServerConnection spawns
      // a fresh daemon instead of reusing the dead socket
      closeKanbanServerConnections();
      const restartResult = await restartKanbanServer(projectRoot);
      return restartResult;
    }
    return {
      serviceId: 'kanban',
      action,
      success: true,
      message: 'Kanban IPC daemon shutdown requested',
    };
  } catch (error) {
    return {
      serviceId: 'kanban',
      action,
      success: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function restartKanbanServer(projectRoot: string): Promise<ServiceActionResult> {
  await waitForShutdown(() => isKanbanServerAvailable(projectRoot));
  try {
    const connection = await getKanbanServerConnection(projectRoot);
    if (!connection) {
      return {
        serviceId: 'kanban',
        action: 'restart',
        success: false,
        message: 'Kanban IPC daemon failed to restart (no connection after re-init)',
      };
    }
    await connection.request('ping', {}, { timeoutMs: 10_000 });
    return {
      serviceId: 'kanban',
      action: 'restart',
      success: true,
      message: 'Kanban IPC daemon restarted successfully',
    };
  } catch (error) {
    return {
      serviceId: 'kanban',
      action: 'restart',
      success: false,
      message: `Kanban IPC daemon restarted but verification failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function killSageServer(
  projectRoot: string,
  action: 'shutdown' | 'restart',
): Promise<ServiceActionResult> {
  if (!isSageProjectServerAvailable()) {
    return {
      serviceId: 'sage',
      action,
      success: false,
      message: 'SAGE project server is unavailable in this runtime',
    };
  }
  const connection = new SageProjectServerConnection(projectRoot);
  try {
    const result = await connection.shutdown(`WebUI request: ${action}`);
    if (!result.stopped) {
      return {
        serviceId: 'sage',
        action,
        success: false,
        message: `SAGE memory server shutdown failed: ${result.reason ?? 'unknown'}`,
      };
    }
    if (action === 'restart') {
      return await restartSageServer(projectRoot);
    }
    return {
      serviceId: 'sage',
      action,
      success: true,
      message: 'SAGE memory server shutdown requested',
    };
  } catch (error) {
    return {
      serviceId: 'sage',
      action,
      success: false,
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    connection.close();
  }
}

async function restartSageServer(projectRoot: string): Promise<ServiceActionResult> {
  await waitForShutdown(async () => {
    const probe = new SageProjectServerConnection(projectRoot);
    try {
      return (await probe.status()) !== null;
    } finally {
      probe.close();
    }
  });
  const verifyConn = new SageProjectServerConnection(projectRoot);
  try {
    // call() uses ensureConnected(true) which spawns + has auth retry loop
    await verifyConn.call(
      'ping',
      {},
      { timeoutMs: 10_000, meta: { clientId: `sage-restart-${process.pid}` } },
    );
    return {
      serviceId: 'sage',
      action: 'restart',
      success: true,
      message: 'SAGE memory server restarted successfully',
    };
  } catch (error) {
    return {
      serviceId: 'sage',
      action: 'restart',
      success: false,
      message: `SAGE memory server restarted but verification failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    verifyConn.close();
  }
}

async function killChronicleServer(
  projectRoot: string,
  action: 'shutdown' | 'restart',
): Promise<ServiceActionResult> {
  const options = resolveChronicleProjectServerOptions({ projectRoot });
  const client = new ChronicleProjectServerClient(options);
  try {
    const result = await client.shutdown(`WebUI request: ${action}`);
    if (!result.stopped) {
      return {
        serviceId: 'chronicle',
        action,
        success: false,
        message: `Chronicle telemetry server shutdown failed: ${result.reason ?? 'unknown'}`,
      };
    }
    if (action === 'restart') {
      return await restartChronicleServer(projectRoot);
    }
    return {
      serviceId: 'chronicle',
      action,
      success: true,
      message: 'Chronicle telemetry server shutdown requested',
    };
  } catch (error) {
    return {
      serviceId: 'chronicle',
      action,
      success: false,
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    client.close();
  }
}

async function restartChronicleServer(projectRoot: string): Promise<ServiceActionResult> {
  // ChronicleProjectServerClient has no non-spawning probe (call() always
  // passes ensureConnected(true)). Use a raw socket probe on the endpoint
  // to detect when the daemon has exited without respawning it.
  const options = resolveChronicleProjectServerOptions({ projectRoot });
  const endpoint = new ChronicleProjectServerClient(options).endpoint;
  await waitForShutdown(async () => isEndpointAlive(endpoint));
  // createChronicleProjectAccess triggers auto-start of the project server
  let access;
  try {
    access = createChronicleProjectAccess({ projectRoot });
    // Verify the server actually came back in server mode (not inline fallback)
    await access.call('ping', {}, { timeoutMs: 10_000 });
    if (access.mode !== 'server') {
      return {
        serviceId: 'chronicle',
        action: 'restart',
        success: false,
        message: `Chronicle telemetry server restarted but running in ${access.mode} mode (expected server)`,
      };
    }
    return {
      serviceId: 'chronicle',
      action: 'restart',
      success: true,
      message: 'Chronicle telemetry server restarted successfully',
    };
  } catch (error) {
    return {
      serviceId: 'chronicle',
      action: 'restart',
      success: false,
      message: `Chronicle telemetry server restarted but verification failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    await access?.close();
  }
}

async function killCodebaseIndexServer(
  projectRoot: string,
  indexDir: string | undefined,
  action: 'shutdown' | 'restart',
): Promise<ServiceActionResult> {
  try {
    const result = await shutdownCodebaseIndexServer(
      projectRoot,
      indexDir,
      `websocket-request:${action}`,
    );
    if (!result.stopped) {
      return {
        serviceId: 'codebase-index',
        action,
        success: false,
        message: `Codebase index server shutdown failed: ${result.reason ?? 'unknown'}`,
      };
    }
    if (action === 'restart') {
      return await restartCodebaseIndexServer(projectRoot, indexDir);
    }
    return {
      serviceId: 'codebase-index',
      action,
      success: true,
      message: 'Codebase index server shutdown requested',
    };
  } catch (error) {
    return {
      serviceId: 'codebase-index',
      action,
      success: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function restartCodebaseIndexServer(
  projectRoot: string,
  indexDir: string | undefined,
): Promise<ServiceActionResult> {
  // Poll until the codebase-index server is actually down before reconnecting
  await waitForShutdown(async () => {
    try {
      await checkCodebaseIndexServerHealth(projectRoot, indexDir, {
        timeoutMs: 1_000,
      });
      return true; // any successful response means the server is still alive
    } catch {
      return false;
    }
  });
  try {
    // ensureCodebaseIndexServer spawns the detached daemon if absent
    await ensureCodebaseIndexServer({ projectRoot, indexDir });
    const health = await checkCodebaseIndexServerHealth(projectRoot, indexDir, {
      timeoutMs: 10_000,
    });
    if (health.status === 'unresponsive') {
      return {
        serviceId: 'codebase-index',
        action: 'restart',
        success: false,
        message: 'Codebase index server restarted but is unresponsive',
      };
    }
    return {
      serviceId: 'codebase-index',
      action: 'restart',
      success: true,
      message: 'Codebase index server restarted successfully',
    };
  } catch (error) {
    return {
      serviceId: 'codebase-index',
      action: 'restart',
      success: false,
      message: `Codebase index server restarted but verification failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function killMailboxServer(
  projectRoot: string,
  action: 'shutdown' | 'restart',
): Promise<ServiceActionResult> {
  if (!isMailboxProjectServerAvailable()) {
    return {
      serviceId: 'mailbox',
      action,
      success: false,
      message: 'Mailbox project server is unavailable in this runtime',
    };
  }
  const connection = new MailboxProjectServerConnection(
    resolveWstackPaths({ projectRoot }).projectDir,
  );
  try {
    const result = await connection.shutdown(`WebUI request: ${action}`);
    if (!result.stopped) {
      return {
        serviceId: 'mailbox',
        action,
        success: false,
        message: `Mailbox IPC server shutdown failed: ${result.reason ?? 'unknown'}`,
      };
    }
    if (action === 'restart') {
      return await restartMailboxServer(projectRoot);
    }
    return {
      serviceId: 'mailbox',
      action,
      success: true,
      message: 'Mailbox IPC server shutdown requested',
    };
  } catch (error) {
    return {
      serviceId: 'mailbox',
      action,
      success: false,
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    connection.close();
  }
}

async function restartMailboxServer(projectRoot: string): Promise<ServiceActionResult> {
  await waitForShutdown(async () => {
    const probe = new MailboxProjectServerConnection(
      resolveWstackPaths({ projectRoot }).projectDir,
    );
    try {
      return (await probe.probeStatus()) !== null;
    } finally {
      probe.close();
    }
  });
  const verifyConn = new MailboxProjectServerConnection(
    resolveWstackPaths({ projectRoot }).projectDir,
  );
  try {
    // call() uses ensureConnected(true) which spawns + has auth retry loop
    await verifyConn.call('ping', {}, { timeoutMs: 10_000 });
    return {
      serviceId: 'mailbox',
      action: 'restart',
      success: true,
      message: 'Mailbox IPC server restarted successfully',
    };
  } catch (error) {
    return {
      serviceId: 'mailbox',
      action: 'restart',
      success: false,
      message: `Mailbox IPC server restarted but verification failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    verifyConn.close();
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

const RESTART_POLL_INTERVAL_MS = 250;
const RESTART_DEADLINE_MS = 3_000;

/**
 * Raw socket probe — checks if anything is listening on an IPC endpoint
 * (Unix domain socket or Windows named pipe) without sending protocol frames.
 * Used for services whose client API offers no non-spawning probe.
 */
function isEndpointAlive(endpoint: string): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection(endpoint);
    const timer = setTimeout(() => {
      sock.destroy();
      resolve(false);
    }, 500);
    timer.unref?.();
    sock.once('connect', () => {
      clearTimeout(timer);
      sock.destroy();
      resolve(true);
    });
    sock.once('error', () => {
      clearTimeout(timer);
      sock.destroy();
      resolve(false);
    });
  });
}

/**
 * Give a shutdown signal time to take effect before re-establishing the
 * connection. When a probe is provided, polls until the server confirms it
 * is down. Falls back to a single sleep when no probe is available.
 */
async function waitForShutdown(probe?: () => Promise<boolean>): Promise<void> {
  if (!probe) {
    await new Promise((resolve) => setTimeout(resolve, RESTART_POLL_INTERVAL_MS));
    return;
  }
  const deadline = Date.now() + RESTART_DEADLINE_MS;
  while (Date.now() < deadline) {
    try {
      const stillUp = await probe();
      if (!stillUp) return;
    } catch {
      return; // probe error → server is likely down
    }
    await new Promise((resolve) => setTimeout(resolve, RESTART_POLL_INTERVAL_MS));
  }
  // Deadline expired — proceed best-effort
}

function failureService(
  id: ConnectionHealthService['id'],
  label: string,
  required: boolean,
  mode: string,
  error: unknown,
  latencyMs?: number,
): ConnectionHealthService {
  const message = error instanceof Error ? error.message : String(error);
  return {
    id,
    label,
    status: 'error',
    required,
    mode,
    detail: message,
    lastError: message,
    ...(latencyMs === undefined ? {} : { latencyMs }),
  };
}
