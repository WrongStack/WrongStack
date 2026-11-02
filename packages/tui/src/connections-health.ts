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

import { createChronicleProjectAccess } from '@wrongstack/chronicle';
import {
  isMailboxProjectServerAvailable,
  MailboxProjectServerConnection,
} from '@wrongstack/coordination';
import { SessionCatalogProjectClient } from '@wrongstack/core/session-catalog';
import { resolveWstackPaths, withDaemonVersion } from '@wrongstack/core/utils';
import { getKanbanServerConnection } from '@wrongstack/kanban';
import { readGovernanceDaemonOperatorStatus } from '@wrongstack/runtime/governance-bootstrap';
import {
  isSageProjectServerAvailable,
  SageProjectServerConnection,
  wrongMemoryPanelHealth,
} from '@wrongstack/sage';
import {
  checkCodebaseIndexServerHealth,
  getIndexState,
  resolveProjectIndexDaemonAvailability,
} from '@wrongstack/tools';

export type ConnectionHealthStatus = 'healthy' | 'degraded' | 'offline' | 'unavailable' | 'error';

export type ConnectionHealthServiceId =
  | 'session-catalog'
  | 'chronicle'
  | 'codebase-index'
  | 'sage'
  | 'kanban'
  | 'mailbox'
  | 'governance';

export interface ConnectionHealthService {
  id: ConnectionHealthServiceId;
  label: string;
  status: ConnectionHealthStatus;
  required: boolean;
  mode: string;
  detail: string;
  versionMismatch?: boolean;
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
  control?: 'restart' | 'none' | undefined;
  advisory?:
    | {
        code: string;
        operatorAction: string;
        executionDisposition: string;
      }
    | undefined;
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
    sessionCatalogHealth(projectRoot),
    chronicleHealth(projectRoot),
    codebaseIndexHealth(projectRoot),
    sageHealth(projectRoot),
    kanbanHealth(projectRoot),
    mailboxHealth(projectRoot),
    governanceHealth(projectRoot),
  ]);
  const required = services.filter((s) => s.required);
  const overall = required.some((s) => s.status === 'error')
    ? 'error'
    : services.some((s) => s.versionMismatch) || required.some((s) => s.status !== 'healthy')
      ? 'degraded'
      : 'healthy';
  return { checkedAt: Date.now(), overall, services };
}

// ── Individual service checks ──────────────────────────────────────────────

async function sessionCatalogHealth(projectRoot: string): Promise<ConnectionHealthService> {
  const startedAt = Date.now();
  try {
    const paths = resolveWstackPaths({ projectRoot });
    const client = new SessionCatalogProjectClient({
      projectDir: paths.projectDir,
      projectRoot,
    });
    try {
      const health = await client.callExisting('ping', {}, { timeoutMs: 3_000 });
      return withDaemonVersion<ConnectionHealthService>(
        {
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
        },
        health?.runtimeVersion,
      );
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
      lastError: error instanceof Error ? error.message : String(error),
    };
  }
}

async function chronicleHealth(projectRoot: string): Promise<ConnectionHealthService> {
  const startedAt = Date.now();
  let access: ReturnType<typeof createChronicleProjectAccess> | undefined;
  try {
    access = createChronicleProjectAccess({ projectRoot });
    const health = await access.call('ping', {}, { timeoutMs: 5_000 });
    const quarantined = health.quarantinedFamilies ?? [];
    return withDaemonVersion<ConnectionHealthService>(
      {
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
      },
      health?.runtimeVersion,
    );
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
    return withDaemonVersion<ConnectionHealthService>(
      {
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
      },
      health.server?.runtimeVersion,
    );
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
  // A project served by WrongMemory has no local SAGE server to probe (and
  // probing must not start one); report the service instead.
  const viaWrongMemory = await wrongMemoryPanelHealth(projectRoot).catch(() => undefined);
  if (viaWrongMemory) {
    return {
      id: 'sage',
      label: 'SAGE memory',
      status: viaWrongMemory.status,
      required: false,
      mode: viaWrongMemory.mode,
      detail: viaWrongMemory.detail,
      latencyMs: Date.now() - startedAt,
    };
  }
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
    return withDaemonVersion<ConnectionHealthService>(
      {
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
      },
      status?.runtimeVersion,
    );
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
    return withDaemonVersion<ConnectionHealthService>(
      {
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
      },
      status?.runtimeVersion,
    );
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
    return withDaemonVersion<ConnectionHealthService>(
      {
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
      },
      status?.runtimeVersion,
    );
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
