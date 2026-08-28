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
import {
  closeKanbanServerConnections,
  getKanbanServerConnection,
  isKanbanServerAvailable,
} from '@wrongstack/kanban';
import { isSageProjectServerAvailable, SageProjectServerConnection } from '@wrongstack/sage';
import {
  checkCodebaseIndexServerHealth,
  ensureCodebaseIndexServer,
  shutdownCodebaseIndexServer,
} from '@wrongstack/tools';
import type { WebSocket } from 'ws';
import { authorizeWebUIAction } from '../privileged-actions.js';
import type { WSClientMessage } from '../types.js';
import { isEndpointAlive, waitForShutdown } from './helpers.js';
import type {
  ConnectionHealthService,
  ConnectionsHealthContext,
  ServiceActionResult,
} from './types.js';

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

export async function executeServiceAction(
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

export async function killKanbanServer(
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

export async function restartKanbanServer(projectRoot: string): Promise<ServiceActionResult> {
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

export async function killSageServer(
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

export async function killChronicleServer(
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
  const options = resolveChronicleProjectServerOptions({ projectRoot });
  const endpoint = new ChronicleProjectServerClient(options).endpoint;
  await waitForShutdown(async () => isEndpointAlive(endpoint));
  let access;
  try {
    access = createChronicleProjectAccess({ projectRoot });
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

export async function killCodebaseIndexServer(
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

export async function killMailboxServer(
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
