/**
 * Message protocol between the index host (main thread) and the index worker.
 *
 * Plain structured-cloneable shapes only — no class instances, no functions.
 * Errors cross the boundary as strings and are re-wrapped by the host.
 */

import type { IncomingCallsResult, OutgoingCallsResult } from './worker-protocol/contracts.js';
import type { CodeMapGraph, IndexResult, IndexStats, SearchResult } from './schema.js';

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
  /** When true, follow the call graph transitively (callers-of-callers / callees-of-callees) via recursive CTE. */
  transitive?: boolean | undefined;
}

export interface SearchOpResult {
  results: SearchResult[];
  total: number;
  /**
   * P2.5: present only on zero-hit responses. Minimal summary (files indexed,
   * last_indexed) so the search tool can distinguish "index exists but nothing
   * matched" from "no persisted index at all" without a separate stats round
   * trip over IPC.
   */
  indexSummary?: { totalFiles: number; lastIndexed: number | null } | undefined;
  /**
   * True when the project server served a previous generation's cached
   * answer while a refresh was publishing (stale-read serving). Never set by
   * the worker/inline path, which refuses reads during a refresh instead.
   */
  stale?: boolean | undefined;
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
