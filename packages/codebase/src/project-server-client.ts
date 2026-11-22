export { closeProjectIndexServerClients } from './project-server-frames-support.js';

import {
  connectionStates,
  getProjectIndexServerConnectionState,
  isProjectIndexServerAvailable,
  latestConnectionState,
  onProjectIndexServerConnectionStateChange,
  type ProjectIndexDaemonAvailability,
  type ProjectIndexServerClientHealth,
  type ProjectIndexServerConnectionState,
  type ProjectIndexServerConnectionStatus,
  type ProjectIndexServerShutdownResult,
  type ProjectServerCallOptions,
  projectIndexServerExpectedBuildId,
  resolveProjectIndexDaemonAvailability,
  SERVER_HEALTH_TIMEOUT_MS,
  setLatestConnectionState,
} from './project-server-client-state.js';
import { projectIndexServerEndpoint } from './project-server-endpoint.js';
import { connections, ProjectServerConnection } from './project-server-frames-support.js';
import type { OpName, OpShapes } from './worker-protocol.js';

export {
  getProjectIndexServerConnectionState,
  onProjectIndexServerConnectionStateChange,
  type ProjectIndexDaemonAvailability,
  type ProjectIndexServerClientHealth,
  type ProjectIndexServerConnectionState,
  type ProjectIndexServerConnectionStatus,
  type ProjectIndexServerShutdownResult,
  projectIndexServerExpectedBuildId,
  resolveProjectIndexDaemonAvailability,
};

const MAX_CACHED_CONNECTIONS = 8;

function forgetConnection(endpoint: string, connection: ProjectServerConnection): void {
  if (connections.get(endpoint) === connection) connections.delete(endpoint);
  connection.close();
  connectionStates.delete(endpoint);
  if (latestConnectionState.endpoint !== endpoint) return;
  setLatestConnectionState(
    [...connectionStates.values()].at(-1) ??
      ({
        status: isProjectIndexServerAvailable() ? 'offline' : 'unavailable',
        connected: false,
      } satisfies ProjectIndexServerConnectionState),
  );
}

function trimConnectionCache(protectedConnection: ProjectServerConnection): void {
  if (connections.size <= MAX_CACHED_CONNECTIONS) return;
  for (const [endpoint, connection] of connections) {
    if (connections.size <= MAX_CACHED_CONNECTIONS) break;
    if (connection === protectedConnection || !connection.isEvictable()) continue;
    forgetConnection(endpoint, connection);
  }
}

function connectionFor(projectRoot: string, indexDir?: string): ProjectServerConnection {
  const endpoint = projectIndexServerEndpoint(projectRoot, indexDir);
  let connection = connections.get(endpoint);
  if (!connection) {
    connection = new ProjectServerConnection(projectRoot, indexDir, endpoint);
    connections.set(endpoint, connection);
  } else {
    connections.delete(endpoint);
    connections.set(endpoint, connection);
  }
  trimConnectionCache(connection);
  return connection;
}

export function callProjectIndexServer<O extends OpName>(
  op: O,
  args: OpShapes[O]['args'],
  options: ProjectServerCallOptions,
): Promise<OpShapes[O]['result']> {
  return connectionFor(args.projectRoot, args.indexDir).call(op, args, options);
}

export function ensureProjectIndexServer(options: {
  projectRoot: string;
  indexDir?: string | undefined;
  watchExternal: boolean;
  debounceMs: number;
  coalesceWindowMs?: number | undefined;
}): Promise<void> {
  return connectionFor(options.projectRoot, options.indexDir).configure(
    options.watchExternal,
    options.debounceMs,
    options.coalesceWindowMs,
  );
}

export function checkProjectIndexServerHealth(
  projectRoot: string,
  indexDir?: string,
  options: { timeoutMs?: number | undefined } = {},
): Promise<ProjectIndexServerClientHealth> {
  return connectionFor(projectRoot, indexDir).checkHealth(
    false,
    options.timeoutMs ?? SERVER_HEALTH_TIMEOUT_MS,
  );
}

export async function shutdownProjectIndexServer(
  projectRoot: string,
  indexDir?: string,
  reason?: string,
): Promise<ProjectIndexServerShutdownResult> {
  const endpoint = projectIndexServerEndpoint(projectRoot, indexDir);
  const connection = connectionFor(projectRoot, indexDir);
  try {
    return await connection.shutdownRemote(reason);
  } finally {
    connection.close();
    connections.delete(endpoint);
    connectionStates.delete(endpoint);
  }
}
