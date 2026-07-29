import {
  ChronicleProjectServerClient,
  createChronicleProjectAccess,
  resolveChronicleProjectServerOptions,
} from '@wrongstack/core/chronicle';
import {
  isMailboxProjectServerAvailable,
  MailboxProjectServerConnection,
} from '@wrongstack/core/coordination';
import { resolveWstackPaths } from '@wrongstack/core/utils';
import { getKanbanServerConnection } from '@wrongstack/kanban';
import { isSageProjectServerAvailable, SageProjectServerConnection } from '@wrongstack/sage';
import {
  checkCodebaseIndexServerHealth,
  getIndexState,
  shutdownCodebaseIndexServer,
} from '@wrongstack/tools';
import type { WebSocket } from 'ws';
import type { WSClientMessage, WSServerMessage } from './types.js';

export type ConnectionHealthStatus = 'healthy' | 'degraded' | 'offline' | 'unavailable' | 'error';

export interface ConnectionHealthService {
  id: 'webui' | 'chronicle' | 'codebase-index' | 'sage' | 'kanban' | 'mailbox';
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
    chronicleHealth(options.projectRoot),
    codebaseIndexHealth(options.projectRoot, options.indexDir),
    sageHealth(options.projectRoot),
    kanbanHealth(options.projectRoot),
    mailboxHealth(options.projectRoot),
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

  if (rawAction !== 'shutdown') {
    context.send(ws, {
      type: 'connections.service_action_result',
      payload: {
        serviceId: serviceId as ConnectionHealthService['id'],
        action: rawAction as 'shutdown' | 'restart',
        success: false,
        message: `Unsupported action "${rawAction}" — only "shutdown" is currently supported`,
      } satisfies ServiceActionResult,
    });
    return true;
  }

  const action: 'shutdown' = rawAction;

  // 'webui' cannot kill itself
  if (serviceId === 'webui') {
    context.send(ws, {
      type: 'connections.service_action_result',
      payload: {
        serviceId: 'webui',
        action: action as 'shutdown' | 'restart',
        success: false,
        message: 'Cannot shut down the WebUI transport itself',
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
    return {
      serviceId: 'kanban',
      action,
      success: result.stopping,
      message: result.stopping
        ? `Kanban IPC daemon ${action} requested`
        : `Kanban IPC daemon ${action} failed (shutdown not confirmed)`,
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
    return {
      serviceId: 'sage',
      action,
      success: result.stopped,
      message: result.stopped
        ? `SAGE memory server ${action} requested`
        : `SAGE memory server ${action} failed: ${result.reason ?? 'unknown'}`,
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

async function killChronicleServer(
  projectRoot: string,
  action: 'shutdown' | 'restart',
): Promise<ServiceActionResult> {
  const options = resolveChronicleProjectServerOptions({ projectRoot });
  const client = new ChronicleProjectServerClient(options);
  try {
    const result = await client.shutdown(`WebUI request: ${action}`);
    return {
      serviceId: 'chronicle',
      action,
      success: result.stopped,
      message: result.stopped
        ? `Chronicle telemetry server ${action} requested`
        : `Chronicle telemetry server ${action} failed: ${result.reason ?? 'unknown'}`,
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
    return {
      serviceId: 'codebase-index',
      action,
      success: result.stopped,
      message: result.stopped
        ? `Codebase index server ${action} requested`
        : `Codebase index server ${action} failed: ${result.reason ?? 'unknown'}`,
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
    return {
      serviceId: 'mailbox',
      action,
      success: result.stopped,
      message: result.stopped
        ? `Mailbox IPC server ${action} requested`
        : `Mailbox IPC server ${action} failed: ${result.reason ?? 'unknown'}`,
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

// ── Helpers ────────────────────────────────────────────────────────────────

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
