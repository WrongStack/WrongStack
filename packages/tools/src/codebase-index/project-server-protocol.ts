import { encodeJsonFrame } from './binary-frame.js';
import type { OpName, OpShapes } from './worker-protocol.js';

/** Hard ceiling for one newline-delimited IPC message (measured as JS characters). */
export const PROJECT_INDEX_SERVER_MAX_FRAME_CHARS = 64 * 1024 * 1024;

/**
 * What the daemon tells a connecting client about itself. Carries NO secret —
 * see {@link ProjectIndexServerMetadata}.
 */
export interface ProjectIndexServerInfo {
  protocolVersion: number;
  buildId: string;
  pid: number;
  projectRoot: string;
  indexDir: string;
  endpoint: string;
  startedAt: string;
  /** P6: server can switch to binary MessagePack framing after handshake. */
  binarySupported?: boolean;
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

/**
 * The daemon's on-disk metadata file, written 0600. The auth token exists here
 * and nowhere else — never in the `hello` frame, which the daemon sends to
 * every socket that connects (the mistake WS-028 found in the SAGE daemon).
 */
export interface ProjectIndexServerMetadata extends ProjectIndexServerInfo {
  authToken: string;
}

/**
 * WS-027: this daemon owns the project's code index — it reads every file in
 * the repository and answers content queries over it — and it had no handshake
 * credential at all. Any process that could open the socket could search the
 * whole codebase through it or drive a reindex. `authToken` comes from the
 * daemon's owner-only metadata file, so a caller must prove same-user access.
 *
 * `cancel` is ungated: it reaches only the sending connection's own in-flight
 * request, so there is nothing to escalate.
 */
export type ProjectServerClientMessage =
  | {
      type: 'request';
      id: number;
      op: OpName;
      args: OpShapes[OpName]['args'];
      authToken?: string | undefined;
    }
  | { type: 'cancel'; id: number }
  | {
      type: 'configure';
      id: number;
      watchExternal: boolean;
      debounceMs: number;
      coalesceWindowMs?: number | undefined;
      authToken?: string | undefined;
    }
  | { type: 'ping'; id: number; authToken?: string | undefined }
  | {
      type: 'shutdown';
      id: number;
      reason?: string | undefined;
      authToken?: string | undefined;
    };

export type ProjectServerMessage =
  | ({ type: 'hello' } & ProjectIndexServerInfo)
  | { type: 'index-state'; state: ProjectIndexServerActivity }
  | { type: 'response'; id: number; ok: true; result: unknown }
  | { type: 'response'; id: number; ok: false; error: string; errorName?: string | undefined }
  | { type: 'progress'; id: number; current: number; total: number };

export function encodeProjectServerMessage(message: object): string {
  // Parity (prod fix): delegate to the shared normalized encoder so REAL
  // wire traffic gets the same Map/Set/Error/RegExp/invalid-Date treatment
  // as the binary framing. Raw JSON.stringify here silently delivered `{}`
  // for Map/Set payloads — the exact divergence the parity tests pin.
  // binary-frame.ts imports nothing local, so this cannot cycle.
  return encodeJsonFrame(message);
}
