/**
 * Message protocol between the index host (main thread) and the index worker.
 *
 * Plain structured-cloneable shapes only — no class instances, no functions.
 * Errors cross the boundary as strings and are re-wrapped by the host.
 */

import type {
  CodeMapGraph,
  IndexResult,
  IndexStats,
  SearchResult,
} from './schema.js';
import type {
  IncomingCallsResult,
  OutgoingCallsResult,
} from './index-service.js';

// ─── Operation arguments ─────────────────────────────────────────────────────

export interface IndexOpArgs {
  projectRoot: string;
  indexDir?: string | undefined;
  files?: string[] | undefined;
  force?: boolean | undefined;
  langs?: string[] | undefined;
  ignore?: string[] | undefined;
}

export interface SearchOpArgs {
  projectRoot: string;
  indexDir?: string | undefined;
  query: string;
  kind?: string | undefined;
  lang?: string | undefined;
  file?: string | undefined;
  lspKind?: number | undefined;
  limit: number;
}

export interface StatsOpArgs {
  projectRoot: string;
  indexDir?: string | undefined;
}

export interface FileGraphOpArgs extends StatsOpArgs {
  packageFilter: string;
}

export interface SymbolGraphOpArgs extends StatsOpArgs {
  fileFilter: string;
}

export interface CallRefsOpArgs extends StatsOpArgs {
  symbol: string;
  file?: string | undefined;
  limit?: number | undefined;
}

export interface SearchOpResult {
  results: SearchResult[];
  total: number;
}

/** Map of op name → { args, result } so host and worker stay in lockstep. */
export interface OpShapes {
  index: { args: IndexOpArgs; result: IndexResult };
  search: { args: SearchOpArgs; result: SearchOpResult };
  stats: { args: StatsOpArgs; result: IndexStats };
  packageGraph: { args: StatsOpArgs; result: CodeMapGraph };
  fileGraph: { args: FileGraphOpArgs; result: CodeMapGraph };
  symbolGraph: { args: SymbolGraphOpArgs; result: CodeMapGraph };
  incomingCalls: { args: CallRefsOpArgs; result: IncomingCallsResult };
  outgoingCalls: { args: CallRefsOpArgs; result: OutgoingCallsResult };
}

export type OpName = keyof OpShapes;

// ─── Wire messages ───────────────────────────────────────────────────────────

export type HostToWorker =
  | { type: 'request'; id: number; op: OpName; args: OpShapes[OpName]['args'] }
  /** Cooperative cancel — aborts the op's signal; the watchdog terminate is the backstop. */
  | { type: 'cancel'; id: number };

export type WorkerToHost =
  | { type: 'response'; id: number; ok: true; result: unknown }
  | { type: 'response'; id: number; ok: false; error: string; errorName?: string | undefined }
  | { type: 'progress'; id: number; current: number; total: number };
