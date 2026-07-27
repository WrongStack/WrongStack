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

export const CHRONICLE_PROJECT_SERVER_PROTOCOL_VERSION = 1;
export const CHRONICLE_PROJECT_SERVER_MAX_FRAME_CHARS = 64 * 1024 * 1024;

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

export type ChronicleProjectServerClientMessage =
  | {
      type: 'request';
      id: number;
      op: ChronicleServerOperationName;
      args: unknown;
    }
  | { type: 'shutdown'; id: number; reason?: string | undefined };

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
