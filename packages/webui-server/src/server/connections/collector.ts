import {
  chronicleProjectServerEndpoint,
  createChronicleProjectAccess,
  resolveChronicleProjectServerOptions,
} from '@wrongstack/core/chronicle';
import {
  isMailboxProjectServerAvailable,
  MailboxProjectServerConnection,
} from '@wrongstack/core/coordination';
import { SessionCatalogProjectClient } from '@wrongstack/core/session-catalog';
import { resolveWstackPaths } from '@wrongstack/core/utils';
import { getKanbanServerConnection, isKanbanServerAvailable } from '@wrongstack/kanban';
import { readGovernanceDaemonOperatorStatus } from '@wrongstack/runtime/governance-bootstrap';
import { isSageProjectServerAvailable, SageProjectServerConnection } from '@wrongstack/sage';
import {
  checkCodebaseIndexServerHealth,
  getIndexState,
  resolveProjectIndexDaemonAvailability,
} from '@wrongstack/tools';
import { errMessage } from '../ws-utils.js';
import { failureService, isEndpointAlive, isOfflineConnectionError } from './helpers.js';
import type { ConnectionHealthService, ConnectionsHealthReport } from './types.js';

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

export async function sessionCatalogHealth(projectRoot: string): Promise<ConnectionHealthService> {
  const startedAt = Date.now();
  try {
    const paths = resolveWstackPaths({ projectRoot });
    const client = new SessionCatalogProjectClient({
      projectDir: paths.projectDir,
      projectRoot,
    });
    try {
      // Connections health is an observer, not a workload. Do not resurrect a
      // sleeping catalog merely because the settings panel refreshes every
      // 15 seconds; a real session client or an explicit restart owns spawn.
      const health = await client.callExisting('ping', {}, { timeoutMs: 3_000 });
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
      };
    } finally {
      await client.close().catch(() => undefined);
    }
  } catch (error) {
    const offline = isOfflineConnectionError(error);
    return {
      id: 'session-catalog',
      label: 'Session Catalog',
      status: offline ? 'offline' : 'error',
      required: !offline,
      mode: offline ? 'on-demand project-daemon' : 'project-daemon',
      detail: offline
        ? 'Not running for this project; it starts on demand when a session is used.'
        : 'Project-scoped session ownership and catalog are unavailable.',
      latencyMs: Date.now() - startedAt,
      lastError: errMessage(error),
    };
  }
}

export async function chronicleHealth(projectRoot: string): Promise<ConnectionHealthService> {
  const startedAt = Date.now();
  let access: ReturnType<typeof createChronicleProjectAccess> | undefined;
  try {
    const endpoint = chronicleProjectServerEndpoint(
      resolveChronicleProjectServerOptions({ projectRoot }).projectDir,
    );
    if (!(await isEndpointAlive(endpoint))) {
      return {
        id: 'chronicle',
        label: 'Chronicle telemetry',
        status: 'offline',
        required: false,
        mode: 'on-demand project-server',
        detail: 'Not running for this project; it starts on demand when telemetry is used.',
        endpoint,
        latencyMs: Date.now() - startedAt,
      };
    }
    access = createChronicleProjectAccess({ projectRoot });
    const health = await access.call('ping', {}, { timeoutMs: 5_000 });
    const quarantined = health.quarantinedFamilies ?? [];
    return {
      id: 'chronicle',
      label: 'Chronicle telemetry',
      status: quarantined.length > 0 ? 'degraded' : 'healthy',
      required: true,
      mode: 'server',
      detail:
        quarantined.length > 0
          ? `Serving, but ${quarantined.length} day(s) were quarantined for a broken chain: ${quarantined
              .map((family) => family.day)
              .join(', ')}.`
          : 'One project owner collects, processes, stores, and serves telemetry.',
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
    if (isOfflineConnectionError(error)) {
      return {
        id: 'chronicle',
        label: 'Chronicle telemetry',
        status: 'offline',
        required: false,
        mode: 'on-demand project-server',
        detail: 'Not running for this project; it starts on demand when telemetry is used.',
        latencyMs: Date.now() - startedAt,
      };
    }
    return failureService(
      'chronicle',
      'Chronicle telemetry',
      true,
      'server',
      error,
      Date.now() - startedAt,
    );
  } finally {
    await access?.close();
  }
}

export async function codebaseIndexHealth(
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
      watcher: health.server ? { active: health.server.watchingExternal } : undefined,
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

export async function sageHealth(projectRoot: string): Promise<ConnectionHealthService> {
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

export async function kanbanHealth(projectRoot: string): Promise<ConnectionHealthService> {
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
  if (!(await isKanbanServerAvailable(projectRoot))) {
    return {
      id: 'kanban',
      label: 'Kanban IPC',
      status: 'offline',
      required: false,
      mode: 'on-demand project-server',
      detail: 'Not running for this project; it starts on demand when kanban is used.',
      latencyMs: Date.now() - startedAt,
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

export async function mailboxHealth(projectRoot: string): Promise<ConnectionHealthService> {
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
