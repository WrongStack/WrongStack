/**
 * TUI-local connection health collection.
 *
 * Mirrors the shape of `@wrongstack/webui-server`'s
 * `collectConnectionsHealth()` but lives here so the TUI does not need a
 * runtime dependency on the WebUI server package. All IPC primitives are
 * available transitively through the TUI's existing dependencies
 * (`@wrongstack/core`, `@wrongstack/kanban`, `@wrongstack/sage`,
 * `@wrongstack/tools`).
 */

import { createChronicleProjectAccess } from '@wrongstack/core/chronicle';
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
  resolveProjectIndexDaemonAvailability,
} from '@wrongstack/tools';

export type ConnectionHealthStatus = 'healthy' | 'degraded' | 'offline' | 'unavailable' | 'error';

export interface ConnectionHealthService {
  id: 'chronicle' | 'codebase-index' | 'sage' | 'kanban' | 'mailbox';
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
  services: ConnectionHealthService[];
}

export async function collectConnectionsHealth(
  projectRoot: string,
): Promise<ConnectionsHealthReport> {
  const services = await Promise.all([
    chronicleHealth(projectRoot),
    codebaseIndexHealth(projectRoot),
    sageHealth(projectRoot),
    kanbanHealth(projectRoot),
    mailboxHealth(projectRoot),
  ]);
  const required = services.filter((s) => s.required);
  const overall = required.some((s) => s.status === 'error')
    ? 'error'
    : required.some((s) => s.status !== 'healthy')
      ? 'degraded'
      : 'healthy';
  return { checkedAt: Date.now(), overall, services };
}

// ── Individual service checks ──────────────────────────────────────────────

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
      watcher: { active: health.watcher.active, watchedFiles: health.watcher.watchedFiles },
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

async function codebaseIndexHealth(projectRoot: string): Promise<ConnectionHealthService> {
  const startedAt = Date.now();
  const availability = resolveProjectIndexDaemonAvailability(projectRoot);
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
    const health = await checkCodebaseIndexServerHealth(projectRoot, undefined, {
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
      storage: connection.indexDir ?? resolveWstackPaths({ projectRoot }).projectCodebaseIndex,
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
    if (isOfflineConnectionError(error)) {
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
    return failureService(
      'codebase-index',
      'Codebase index',
      false,
      'project-server',
      error,
      Date.now() - startedAt,
    );
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
      detail: `Single shared project-server owns kanban state (v${status.protocolVersion}).`,
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
  // Keyed on the data directory, not the repo root — see the WebUI collector.
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
      detail: `Single shared project-server owns inter-agent mailbox state (v${status.protocolVersion}).`,
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

// ── Helpers ────────────────────────────────────────────────────────────────

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
