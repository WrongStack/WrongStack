import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkUnixSocketPath } from '@wrongstack/core/utils';
import { IndexTimeoutError, LockError } from './circuit-breaker.js';
import {
  projectIndexServerBuildId,
  projectIndexServerEndpoint,
} from './project-server-endpoint.js';
import type {
  ProjectIndexServerActivity,
  ProjectIndexServerHealth,
} from './project-server-protocol.js';

export const CONNECT_ATTEMPT_TIMEOUT_MS = 750;
export const SERVER_START_TIMEOUT_MS = 10_000;
export const SERVER_CONTROL_TIMEOUT_MS = 5_000;
export const SERVER_HEALTH_TIMEOUT_MS = 3_000;
export const SERVER_HEARTBEAT_INTERVAL_MS = 10_000;

export class StaleProjectIndexServerError extends Error {
  override readonly name = 'StaleProjectIndexServerError';

  constructor(
    message: string,
    readonly pid: number,
  ) {
    super(message);
  }
}

export interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: unknown): void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal | undefined;
  onAbort?: (() => void) | undefined;
  onProgress?: ((current: number, total: number) => void) | undefined;
}

export interface ProjectServerCallOptions {
  timeoutMs: number;
  signal?: AbortSignal | undefined;
  onProgress?: ((current: number, total: number) => void) | undefined;
}

export interface ProjectIndexServerShutdownResult {
  stopped: boolean;
  pid?: number | undefined;
  reason?: string | undefined;
}

export type ProjectIndexServerConnectionStatus =
  | 'unavailable'
  | 'offline'
  | 'connecting'
  | 'connected'
  | 'degraded'
  | 'unresponsive'
  | 'error'
  | 'stopping';

export interface ProjectIndexServerClientHealth {
  status: 'healthy' | 'degraded' | 'unresponsive';
  checkedAt: number;
  lastHealthyAt: number | null;
  latencyMs: number | null;
  missedHeartbeats: number;
  server?: ProjectIndexServerHealth | undefined;
}

export interface ProjectIndexServerConnectionState {
  status: ProjectIndexServerConnectionStatus;
  connected: boolean;
  projectRoot?: string | undefined;
  indexDir?: string | undefined;
  endpoint?: string | undefined;
  pid?: number | undefined;
  lastError?: string | undefined;
  activity?: ProjectIndexServerActivity | undefined;
  health?: ProjectIndexServerClientHealth | undefined;
}

type ProjectIndexServerConnectionListener = (
  state: ProjectIndexServerConnectionState,
) => void;

export const connectionStates = new Map<string, ProjectIndexServerConnectionState>();
const connectionStateListeners = new Set<ProjectIndexServerConnectionListener>();
export let latestConnectionState: ProjectIndexServerConnectionState = {
  status: 'offline',
  connected: false,
};

export function setLatestConnectionState(state: ProjectIndexServerConnectionState): void {
  latestConnectionState = state;
}

export type ProjectIndexDaemonAvailability =
  | { readonly kind: 'available'; readonly url: URL }
  | { readonly kind: 'inline-requested' }
  | { readonly kind: 'missing-build' }
  | {
      readonly kind: 'endpoint-invalid';
      readonly endpoint: string;
      readonly byteLength: number;
      readonly maxBytes: number;
    };

export function resolveProjectIndexDaemonAvailability(
  projectRoot?: string,
  indexDir?: string,
): ProjectIndexDaemonAvailability {
  if (process.env['WRONGSTACK_INDEX_INLINE'] || process.env['WRONGSTACK_INDEX_SERVER'] === '0') {
    return { kind: 'inline-requested' };
  }
  let builtUrl: URL | null = null;
  for (const rel of ['./project-server.js', './codebase-index/project-server.js']) {
    try {
      const url = new URL(rel, import.meta.url);
      if (url.protocol === 'file:' && fs.existsSync(fileURLToPath(url))) {
        builtUrl = url;
        break;
      }
    } catch {
      /* try the next candidate */
    }
  }
  if (builtUrl === null) return { kind: 'missing-build' };
  if (projectRoot !== undefined) {
    const endpoint = projectIndexServerEndpoint(projectRoot, indexDir);
    const check = checkUnixSocketPath(endpoint);
    if (!check.ok) {
      return {
        kind: 'endpoint-invalid',
        endpoint,
        byteLength: check.byteLength,
        maxBytes: check.maxBytes,
      };
    }
  }
  return { kind: 'available', url: builtUrl };
}

export function resolveProjectServerUrl(): URL | null {
  const availability = resolveProjectIndexDaemonAvailability();
  return availability.kind === 'available' ? availability.url : null;
}

export function projectIndexServerExpectedBuildId(): string | null {
  const override = process.env['WRONGSTACK_INDEX_SERVER_BUILD_ID']?.trim();
  if (override) return override;
  const url = resolveProjectServerUrl();
  return url ? projectIndexServerBuildId(url) : null;
}

export function isProjectIndexServerAvailable(): boolean {
  return resolveProjectServerUrl() !== null;
}

export function publishConnectionState(
  endpoint: string,
  state: ProjectIndexServerConnectionState,
): void {
  connectionStates.set(endpoint, state);
  latestConnectionState = state;
  for (const listener of connectionStateListeners) listener(state);
}

export function getProjectIndexServerConnectionState(
  projectRoot?: string,
  indexDir?: string,
): ProjectIndexServerConnectionState {
  if (projectRoot) {
    const endpoint = projectIndexServerEndpoint(projectRoot, indexDir);
    const existing = connectionStates.get(endpoint);
    if (existing) return existing;
    if (!isProjectIndexServerAvailable()) {
      return { status: 'unavailable', connected: false };
    }
    return {
      status: 'offline',
      connected: false,
      projectRoot,
      indexDir,
      endpoint,
    };
  }
  if (latestConnectionState.endpoint) return latestConnectionState;
  if (!isProjectIndexServerAvailable()) return { status: 'unavailable', connected: false };
  return latestConnectionState;
}

export function onProjectIndexServerConnectionStateChange(
  listener: ProjectIndexServerConnectionListener,
): () => void {
  connectionStateListeners.add(listener);
  return () => connectionStateListeners.delete(listener);
}

export function remoteError(message: string, name?: string): Error {
  if (name === 'LockError') return new LockError(message);
  if (name === 'IndexTimeoutError') return new IndexTimeoutError(message);
  const error = new Error(message);
  if (name && name !== 'Error') error.name = name;
  return error;
}

export function isProjectIndexServerHealth(value: unknown): value is ProjectIndexServerHealth {
  if (!value || typeof value !== 'object') return false;
  const health = value as Partial<ProjectIndexServerHealth>;
  const memory =
    health.memory && typeof health.memory === 'object'
      ? (health.memory as Partial<ProjectIndexServerHealth['memory']>)
      : undefined;
  const activity =
    health.activity && typeof health.activity === 'object'
      ? (health.activity as Partial<ProjectIndexServerActivity>)
      : undefined;
  return (
    typeof health.checkedAt === 'number' &&
    typeof health.uptimeMs === 'number' &&
    typeof memory?.rss === 'number' &&
    typeof memory.heapUsed === 'number' &&
    typeof memory.heapTotal === 'number' &&
    typeof memory.external === 'number' &&
    typeof health.clients === 'number' &&
    typeof health.activeRequests === 'number' &&
    typeof health.activeWrites === 'number' &&
    typeof health.queuedWrites === 'number' &&
    typeof health.pendingExternalFiles === 'number' &&
    typeof health.watchingExternal === 'boolean' &&
    typeof activity?.indexing === 'boolean' &&
    typeof activity.currentFile === 'number' &&
    typeof activity.totalFiles === 'number' &&
    typeof activity.generation === 'number'
  );
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export function cancellationError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Indexing cancelled');
}
