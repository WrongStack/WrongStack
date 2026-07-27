import type { OpName, OpShapes } from './worker-protocol.js';

/** Hard ceiling for one newline-delimited IPC message (measured as JS characters). */
export const PROJECT_INDEX_SERVER_MAX_FRAME_CHARS = 64 * 1024 * 1024;

export interface ProjectIndexServerInfo {
  protocolVersion: number;
  buildId: string;
  pid: number;
  projectRoot: string;
  indexDir: string;
  endpoint: string;
  startedAt: string;
}

export interface ProjectIndexServerActivity {
  indexing: boolean;
  currentFile: number;
  totalFiles: number;
  generation: number;
  updatedAt: number | null;
  lastError: string | null;
}

export interface ProjectIndexServerHealth {
  checkedAt: number;
  uptimeMs: number;
  memory: {
    rss: number;
    heapUsed: number;
    heapTotal: number;
    external: number;
  };
  clients: number;
  activeRequests: number;
  activeWrites: number;
  queuedWrites: number;
  pendingExternalFiles: number;
  watchingExternal: boolean;
  /** Clients currently requesting ownership of the shared external watcher. */
  watchingClients?: number | undefined;
  /** Server-side heartbeat lease applied to connected clients. */
  clientLeaseTimeoutMs?: number | undefined;
  /** Time since the least recently responsive client sent a message. */
  oldestClientIdleMs?: number | undefined;
  activity: ProjectIndexServerActivity;
}

export type ProjectServerClientMessage =
  | { type: 'request'; id: number; op: OpName; args: OpShapes[OpName]['args'] }
  | { type: 'cancel'; id: number }
  | { type: 'configure'; id: number; watchExternal: boolean; debounceMs: number }
  | { type: 'ping'; id: number }
  | { type: 'shutdown'; id: number; reason?: string | undefined };

export type ProjectServerMessage =
  | ({ type: 'hello' } & ProjectIndexServerInfo)
  | { type: 'index-state'; state: ProjectIndexServerActivity }
  | { type: 'response'; id: number; ok: true; result: unknown }
  | { type: 'response'; id: number; ok: false; error: string; errorName?: string | undefined }
  | { type: 'progress'; id: number; current: number; total: number };

export function encodeProjectServerMessage(message: object): string {
  return `${JSON.stringify(message)}\n`;
}
