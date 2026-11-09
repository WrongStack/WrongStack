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
import type { WebSocket } from 'ws';
import { authorizeWebUIAction } from '../privileged-actions.js';
import type { WSClientMessage } from '../types.js';
import { withRequestId } from '../ws-utils.js';
import { waitForShutdown } from './helpers.js';
import {
  killChronicleServer,
  killCodebaseIndexServer,
  killMailboxServer,
  killSageServer,
} from './service-action-restarts.js';
import type {
  ConnectionHealthService,
  ConnectionsHealthContext,
  ServiceActionResult,
} from './types.js';

export {
  killChronicleServer,
  killCodebaseIndexServer,
  killMailboxServer,
  killSageServer,
} from './service-action-restarts.js';

export async function handleConnectionsServiceAction(
  ws: WebSocket,
  message: WSClientMessage,
  context: ConnectionsHealthContext,
): Promise<boolean> {
  if (message.type !== 'connections.service_action') return false;
  const sendReply = (result: ServiceActionResult): void =>
    context.send(ws, {
      type: 'connections.service_action_result',
      payload: withRequestId(message, { ...result }),
    });

  const payload = message.payload as { serviceId?: string; action?: string } | undefined;
  const serviceId = payload?.serviceId;
  const rawAction = payload?.action ?? 'shutdown';

  if (!serviceId) {
    sendReply({
      serviceId: null,
      action: rawAction as 'shutdown' | 'restart',
      success: false,
      message: 'Missing serviceId in payload',
    });
    return true;
  }

  if (rawAction !== 'shutdown' && rawAction !== 'restart') {
    sendReply({
      serviceId: serviceId as ConnectionHealthService['id'],
      action: rawAction as 'shutdown' | 'restart',
      success: false,
      message: `Unsupported action "${rawAction}" — only "shutdown" and "restart" are supported`,
    });
    return true;
  }

  const action = rawAction;

  if (!context.trustBoundary) {
    sendReply({
      serviceId: serviceId as ConnectionHealthService['id'],
      action: action as 'shutdown' | 'restart',
      success: false,
      message: 'Service control is unavailable: no policy authority is configured.',
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
    sendReply({
      serviceId: serviceId as ConnectionHealthService['id'],
      action: action as 'shutdown' | 'restart',
      success: false,
      message: authorization.reason ?? 'Refused by policy.',
    });
    return true;
  }

  if (serviceId === 'webui') {
    sendReply({
      serviceId: 'webui',
      action: action as 'shutdown' | 'restart',
      success: false,
      message:
        action === 'restart'
          ? 'Cannot restart the WebUI transport itself'
          : 'Cannot shut down the WebUI transport itself',
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
    sendReply(result);
  } catch (error) {
    sendReply({
      serviceId: serviceId as ConnectionHealthService['id'],
      action: action as 'shutdown' | 'restart',
      success: false,
      message: toErrorMessage(error),
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

export async function killSessionCatalogServer(
  projectRoot: string,
  action: 'shutdown' | 'restart',
): Promise<ServiceActionResult> {
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
    const result = await client.shutdown(`WebUI request: ${action}`);
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
): Promise<ServiceActionResult> {
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
      message: toErrorMessage(error),
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
