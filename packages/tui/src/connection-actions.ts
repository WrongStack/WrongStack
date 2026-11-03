import * as net from 'node:net';
import {
  ChronicleProjectServerClient,
  createChronicleProjectAccess,
  resolveChronicleProjectServerOptions,
} from '@wrongstack/chronicle';
import {
  isMailboxProjectServerAvailable,
  MailboxProjectServerConnection,
} from '@wrongstack/coordination';
import { SessionCatalogProjectClient } from '@wrongstack/core/session-catalog';
import {
  assertDaemonRuntimeVersion,
  resolveWstackPaths,
  toErrorMessage,
} from '@wrongstack/core/utils';
import {
  closeKanbanServerConnections,
  getKanbanServerConnection,
  isKanbanServerAvailable,
} from '@wrongstack/kanban';
import {
  isSageProjectServerAvailable,
  SageProjectServerConnection,
  wrongMemoryServiceActionRefusal,
} from '@wrongstack/sage';
import {
  checkCodebaseIndexServerHealth,
  ensureCodebaseIndexServer,
  shutdownCodebaseIndexServer,
} from '@wrongstack/tools';
import type { ConnectionHealthServiceId } from './connections-health.js';

export interface ConnectionActionResult {
  serviceId: ConnectionHealthServiceId;
  action: 'shutdown' | 'restart';
  success: boolean;
  message: string;
}

export const RESTARTABLE_SERVICES: readonly ConnectionHealthServiceId[] = [
  'session-catalog',
  'chronicle',
  'codebase-index',
  'sage',
  'kanban',
  'mailbox',
];

export function isRestartableService(serviceId: ConnectionHealthServiceId): boolean {
  return (RESTARTABLE_SERVICES as readonly string[]).includes(serviceId);
}

export function isEndpointAlive(endpoint: string): Promise<boolean> {
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

export async function waitForShutdown(probe?: () => Promise<boolean> | boolean): Promise<void> {
  const pollIntervalMs = 250;
  if (!probe) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    return;
  }
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      const stillUp = await probe();
      if (!stillUp) return;
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw new Error('Daemon did not stop before the restart deadline; restart was not verified.');
}

export async function executeConnectionAction(
  serviceId: ConnectionHealthServiceId,
  action: 'shutdown' | 'restart',
  projectRoot: string,
  indexDir?: string | undefined,
): Promise<ConnectionActionResult> {
  switch (serviceId) {
    case 'session-catalog':
      return killSessionCatalogServer(projectRoot, action);
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
        message: 'Governance control plane is read-only; daemon restart is not supported.',
      };
    default:
      return {
        serviceId,
        action,
        success: false,
        message: `Unknown service: ${serviceId}`,
      };
  }
}

export async function restartAllConnectionServices(
  projectRoot: string,
  indexDir?: string | undefined,
): Promise<ConnectionActionResult[]> {
  const results: ConnectionActionResult[] = [];
  for (const id of RESTARTABLE_SERVICES) {
    try {
      results.push(await executeConnectionAction(id, 'restart', projectRoot, indexDir));
    } catch (error) {
      results.push({
        serviceId: id,
        action: 'restart',
        success: false,
        message: toErrorMessage(error),
      });
    }
  }
  return results;
}

export async function killSessionCatalogServer(
  projectRoot: string,
  action: 'shutdown' | 'restart',
): Promise<ConnectionActionResult> {
  const paths = resolveWstackPaths({ projectRoot });
  const client = new SessionCatalogProjectClient({
    projectDir: paths.projectDir,
    projectRoot,
  });
  try {
    const previousPid =
      action === 'restart'
        ? await client.callExisting('ping', {}, { timeoutMs: 1_000 }).then(
            (health) => health.pid,
            () => undefined,
          )
        : undefined;
    const result = await client.shutdown(`TUI request: ${action}`);
    if (!result.stopped && action === 'shutdown') {
      return {
        serviceId: 'session-catalog',
        action,
        success: false,
        message: 'Session Catalog IPC daemon is not running',
      };
    }
    if (action === 'restart') return await restartSessionCatalogServer(projectRoot, previousPid);
    return {
      serviceId: 'session-catalog',
      action,
      success: true,
      message: 'Session Catalog IPC daemon shutdown requested',
    };
  } catch (error) {
    return {
      serviceId: 'session-catalog',
      action,
      success: false,
      message: toErrorMessage(error),
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function restartSessionCatalogServer(
  projectRoot: string,
  previousPid?: number,
): Promise<ConnectionActionResult> {
  const paths = resolveWstackPaths({ projectRoot });
  const probe = () => {
    const client = new SessionCatalogProjectClient({
      projectDir: paths.projectDir,
      projectRoot,
    });
    return client
      .callExisting('ping', {}, { timeoutMs: 1_000 })
      .then(
        () => true,
        () => false,
      )
      .finally(() => client.close().catch(() => undefined));
  };
  await waitForShutdown(probe);
  const verify = new SessionCatalogProjectClient({
    projectDir: paths.projectDir,
    projectRoot,
  });
  try {
    const health = await verify.ping();
    assertDaemonRuntimeVersion(health.runtimeVersion);
    if (previousPid !== undefined && health.pid === previousPid) {
      return {
        serviceId: 'session-catalog',
        action: 'restart',
        success: false,
        message: `Session Catalog IPC daemon did not restart (owner PID is still ${previousPid})`,
      };
    }
    return {
      serviceId: 'session-catalog',
      action: 'restart',
      success: true,
      message: 'Session Catalog IPC daemon restarted successfully',
    };
  } catch (error) {
    return {
      serviceId: 'session-catalog',
      action: 'restart',
      success: false,
      message: `Session Catalog IPC daemon restarted but verification failed: ${toErrorMessage(error)}`,
    };
  } finally {
    await verify.close().catch(() => undefined);
  }
}

export async function killKanbanServer(
  projectRoot: string,
  action: 'shutdown' | 'restart',
): Promise<ConnectionActionResult> {
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
      message: toErrorMessage(error),
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
      reason: `TUI request: ${action}`,
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
      closeKanbanServerConnections();
      return await restartKanbanServer(projectRoot);
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
      message: toErrorMessage(error),
    };
  }
}

async function restartKanbanServer(projectRoot: string): Promise<ConnectionActionResult> {
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
    const health = await connection.request('ping', {}, { timeoutMs: 10_000 });
    assertDaemonRuntimeVersion(health.runtimeVersion);
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
      message: `Kanban IPC daemon restarted but verification failed: ${toErrorMessage(error)}`,
    };
  }
}

export async function killSageServer(
  projectRoot: string,
  action: 'shutdown' | 'restart',
): Promise<ConnectionActionResult> {
  const servedByWrongMemory = wrongMemoryServiceActionRefusal(projectRoot);
  if (servedByWrongMemory) {
    return { serviceId: 'sage', action, success: false, message: servedByWrongMemory };
  }
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
    const result = await connection.shutdown(`TUI request: ${action}`);
    if (!result.stopped) {
      if (action === 'restart' && result.reason === 'not-running') {
        return await restartSageServer(projectRoot);
      }
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
      message: toErrorMessage(error),
    };
  } finally {
    connection.close();
  }
}

async function restartSageServer(projectRoot: string): Promise<ConnectionActionResult> {
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
    const health = await verifyConn.call(
      'ping',
      {},
      { timeoutMs: 10_000, meta: { clientId: `sage-restart-${process.pid}` } },
    );
    assertDaemonRuntimeVersion(health.runtimeVersion);
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
      message: `SAGE memory server restarted but verification failed: ${toErrorMessage(error)}`,
    };
  } finally {
    verifyConn.close();
  }
}

export async function killChronicleServer(
  projectRoot: string,
  action: 'shutdown' | 'restart',
): Promise<ConnectionActionResult> {
  const options = resolveChronicleProjectServerOptions({ projectRoot });
  const client = new ChronicleProjectServerClient(options);
  try {
    const result = await client.shutdown(`TUI request: ${action}`);
    if (!result.stopped) {
      if (action === 'restart' && result.reason === 'offline') {
        return await restartChronicleServer(projectRoot);
      }
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
      message: toErrorMessage(error),
    };
  } finally {
    client.close();
  }
}

async function restartChronicleServer(projectRoot: string): Promise<ConnectionActionResult> {
  const options = resolveChronicleProjectServerOptions({ projectRoot });
  const endpoint = new ChronicleProjectServerClient(options).endpoint;
  await waitForShutdown(async () => isEndpointAlive(endpoint));
  let access;
  try {
    access = createChronicleProjectAccess({ projectRoot });
    const health = await access.call('ping', {}, { timeoutMs: 10_000 });
    if (access.mode !== 'server') {
      return {
        serviceId: 'chronicle',
        action: 'restart',
        success: false,
        message: `Chronicle telemetry server restarted but running in ${access.mode} mode (expected server)`,
      };
    }
    assertDaemonRuntimeVersion(health.runtimeVersion);
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
      message: `Chronicle telemetry server restarted but verification failed: ${toErrorMessage(error)}`,
    };
  } finally {
    await access?.close();
  }
}

export async function killCodebaseIndexServer(
  projectRoot: string,
  indexDir: string | undefined,
  action: 'shutdown' | 'restart',
): Promise<ConnectionActionResult> {
  try {
    const result = await shutdownCodebaseIndexServer(
      projectRoot,
      indexDir,
      `tui-request:${action}`,
    );
    if (!result.stopped) {
      if (action === 'restart' && result.reason === 'not-running') {
        return await restartCodebaseIndexServer(projectRoot, indexDir);
      }
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
      message: toErrorMessage(error),
    };
  }
}

async function restartCodebaseIndexServer(
  projectRoot: string,
  indexDir: string | undefined,
): Promise<ConnectionActionResult> {
  await waitForShutdown(async () => {
    try {
      await checkCodebaseIndexServerHealth(projectRoot, indexDir, {
        timeoutMs: 1_000,
      });
      return true;
    } catch {
      return false;
    }
  });
  try {
    await ensureCodebaseIndexServer({ projectRoot, indexDir });
    const health = await checkCodebaseIndexServerHealth(projectRoot, indexDir, {
      timeoutMs: 10_000,
    });
    if (health.status !== 'healthy') {
      return {
        serviceId: 'codebase-index',
        action: 'restart',
        success: false,
        message: `Codebase index server restart verification failed: ${health.status}`,
      };
    }
    assertDaemonRuntimeVersion(health.server?.runtimeVersion);
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
      message: `Codebase index server restarted but verification failed: ${toErrorMessage(error)}`,
    };
  }
}

export async function killMailboxServer(
  projectRoot: string,
  action: 'shutdown' | 'restart',
): Promise<ConnectionActionResult> {
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
    const result = await connection.shutdown(`TUI request: ${action}`);
    if (!result.stopped) {
      if (action === 'restart' && result.reason === 'offline') {
        return await restartMailboxServer(projectRoot);
      }
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
      message: toErrorMessage(error),
    };
  } finally {
    connection.close();
  }
}

async function restartMailboxServer(projectRoot: string): Promise<ConnectionActionResult> {
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
    const health = await verifyConn.call('ping', {}, { timeoutMs: 10_000 });
    assertDaemonRuntimeVersion(health.runtimeVersion);
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
      message: `Mailbox IPC server restarted but verification failed: ${toErrorMessage(error)}`,
    };
  } finally {
    verifyConn.close();
  }
}
