import type { ChronicleJournalStats, ChroniclePurgeResult } from './journal.js';
import type { ChronicleMetricsRefreshResult } from './metrics-store.js';
import type {
  ChronicleFacet,
  ChronicleFacetResults,
  ChronicleFacetValue,
  ChronicleGraphResult,
  ChronicleQuery,
  ChronicleQueryResult,
} from './query.js';
import type { ChronicleEvent, ChronicleEventInput } from './types.js';

export const CHRONICLE_PROJECT_SERVER_PROTOCOL_VERSION = 2;
export const CHRONICLE_PROJECT_SERVER_MAX_FRAME_CHARS = 64 * 1024 * 1024;

/**
 * Most events one `append` call may carry.
 *
 * This lives in the protocol module because both ends must agree on it, and
 * they did not: the server rejected anything above this bound while the client
 * drained its entire backlog into a single call, with a backpressure ceiling ten
 * times higher. A client that ever accumulated more than this — which only
 * happens when the daemon is slow or restarting, exactly when the telemetry
 * matters — had its whole batch rejected as malformed and lost every event in
 * it, rather than persisting what it could. A shared constant is what keeps the
 * producer's chunking and the consumer's validation from drifting apart again.
 */
export const CHRONICLE_MAX_APPEND_BATCH = 10_000;

/**
 * What the daemon tells a connecting client about itself. Carries NO secret —
 * see {@link ChronicleProjectServerMetadata}.
 */
export interface ChronicleProjectServerInfo {
  protocolVersion: number;
  pid: number;
  projectRoot: string;
  projectDir: string;
  chronicleDirectory: string;
  endpoint: string;
  startedAt: string;
}

export interface ChronicleProjectServerHealth extends ChronicleProjectServerInfo {
  checkedAt: number;
  uptimeMs: number;
  clients: number;
  activeRequests: number;
  journal: ChronicleJournalStats;
  watcher: {
    active: boolean;
    watchedFiles: number;
    lastError?: string | undefined;
  };
  /**
   * Day families the legacy JSONL import refused to move for a broken chain.
   *
   * Present and non-empty means the journal has a known hole: those days were
   * never imported and never will be. Health surfaces it as degraded rather
   * than healthy — a store that silently serves an incomplete audit record is
   * worse than one that says which day is missing.
   */
  quarantinedFamilies?: Array<{ day: string; sequence: number; reason: string }> | undefined;
  memory: {
    rss: number;
    heapUsed: number;
    heapTotal: number;
    external: number;
  };
}

export type ChronicleMetricsView = 'summary' | 'providers' | 'tasks' | 'files';

export interface ChronicleMetricsRequest {
  view: ChronicleMetricsView;
  /**
   * When false, serve the current derived projection immediately and refresh
   * it in the background. Latency-sensitive enrichment must not wait for a
   * multi-GB historical backlog to be indexed.
   */
  refresh?: boolean;
  providers?: { from?: string; to?: string };
  tasks?: {
    runId?: string;
    boardId?: string;
    sessionId?: string;
    status?: string;
    limit?: number;
  };
  files?: {
    path?: string;
    paths?: string[];
    latestPerPath?: boolean;
    taskId?: string;
    boardId?: string;
    sessionId?: string;
    limit?: number;
  };
}

export interface ChronicleMetricsResponse {
  refreshed: ChronicleMetricsRefreshResult;
  data: unknown;
}

export interface ChronicleServerOperations {
  ping: { args: Record<string, never>; result: ChronicleProjectServerHealth };
  append: { args: { inputs: ChronicleEventInput[] }; result: ChronicleEvent[] };
  flush: { args: Record<string, never>; result: void };
  purge: {
    args: { retentionDays: number; dryRun?: boolean };
    result: ChroniclePurgeResult;
  };
  query: { args: { query: ChronicleQuery }; result: ChronicleQueryResult };
  facet: {
    args: { field: ChronicleFacet; query: ChronicleQuery; limit?: number | undefined };
    result: {
      values: ChronicleFacetValue[];
      diagnostics: { sourceFiles: number; invalidLines: number };
    };
  };
  facets: {
    args: { fields: ChronicleFacet[]; query: ChronicleQuery; limit?: number | undefined };
    result: {
      values: ChronicleFacetResults;
      diagnostics: { sourceFiles: number; invalidLines: number };
    };
  };
  graph: {
    args: { seed: ChronicleQuery; hops?: number | undefined; maxNodes?: number | undefined };
    result: ChronicleGraphResult;
  };
  metrics: { args: ChronicleMetricsRequest; result: ChronicleMetricsResponse };
}

export type ChronicleServerOperationName = keyof ChronicleServerOperations;

/**
 * The daemon's on-disk metadata file, written 0600. The auth token exists here
 * and nowhere else — never in the `hello` frame, which the daemon sends to
 * every socket that connects (the mistake WS-028 found in the SAGE daemon).
 */
export interface ChronicleProjectServerMetadata extends ChronicleProjectServerInfo {
  authToken: string;
}

export type ChronicleProjectServerClientMessage =
  | {
      type: 'request';
      id: number;
      op: ChronicleServerOperationName;
      args: unknown;
      /**
       * WS-027: this daemon owns the project's chronicle — the durable record
       * of what every agent did — and it had no handshake credential at all.
       * Any process that could open the socket could read that history or
       * append to it. The token comes from the daemon's owner-only metadata
       * file, so a caller must prove same-user access before it may act.
       */
      authToken?: string | undefined;
    }
  | {
      type: 'shutdown';
      id: number;
      reason?: string | undefined;
      /** Gated for the same reason — this stops the daemon for every client. */
      authToken?: string | undefined;
    };

export type ChronicleProjectServerMessage =
  | ({ type: 'hello' } & ChronicleProjectServerInfo)
  | { type: 'response'; id: number; ok: true; result: unknown }
  | {
      type: 'response';
      id: number;
      ok: false;
      error: string;
      errorName?: string | undefined;
    };

export function encodeChronicleProjectServerMessage(message: object): string {
  return `${JSON.stringify(message)}\n`;
}
