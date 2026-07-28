import { createChronicleProjectAccess } from '@wrongstack/core/chronicle';
import { resolveWstackPaths } from '@wrongstack/core/utils';
import { getKanbanDir, getKanbanServerConnection } from '@wrongstack/kanban';
import { isSageProjectServerAvailable, SageProjectServerConnection } from '@wrongstack/sage';
import { checkCodebaseIndexServerHealth, getIndexState } from '@wrongstack/tools';
import type { WebSocket } from 'ws';
import type { WSClientMessage, WSServerMessage } from './types.js';

export type ConnectionHealthStatus = 'healthy' | 'degraded' | 'offline' | 'unavailable' | 'error';

export interface ConnectionHealthService {
  id: 'webui' | 'chronicle' | 'codebase-index' | 'sage' | 'kanban';
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
  const access = createChronicleProjectAccess({ projectRoot });
  try {
    const health = await access.call('ping', {}, { timeoutMs: 5_000 });
    return {
      id: 'chronicle',
      label: 'Chronicle telemetry',
      status: access.mode === 'server' ? 'healthy' : 'degraded',
      required: true,
      mode: access.mode,
      detail:
        access.mode === 'server'
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
      ...(health.watcher.lastError ? { lastError: health.watcher.lastError } : {}),
    };
  } catch (error) {
    return failureService(
      'chronicle',
      'Chronicle telemetry',
      true,
      access.mode,
      error,
      Date.now() - startedAt,
    );
  } finally {
    await access.close();
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
      storage: getKanbanDir(projectRoot),
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
      storage: getKanbanDir(projectRoot),
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
      storage: getKanbanDir(projectRoot),
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
