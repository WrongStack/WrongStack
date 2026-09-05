/**
 * `codebase-stats` tool — report index health and statistics.
 *
 * Usage: codebase-stats({})
 *
 * Returns: { totalSymbols, totalFiles, byLang, byKind, lastIndexed, sizeBytes, version }
 */

import type { Tool } from '@wrongstack/core/types';
import { toErrorMessage } from '@wrongstack/core/utils';
import { codebaseIndexStats, getIndexState } from './background-indexer.js';
import { IndexTimeoutError } from './circuit-breaker.js';
import { SCHEMA_VERSION } from './schema.js';
import { codebaseIndexDirOverride, resolveIndexDir } from './writer.js';

export interface CodebaseStatsInput {}

export const codebaseStatsTool: Tool<CodebaseStatsInput, CodebaseStatsOutput> = {
  name: 'codebase-stats',
  category: 'Project',
  icon: 'index',
  description:
    'Check whether a persisted codebase index exists and report its health and statistics (symbols, files, language/kind breakdown, size, last update).',
  usageHint:
    'CHECK ONCE BEFORE BROAD CODE EXPLORATION:\n\n' +
    '- Call before broad `tree`, `glob`, or `grep` exploration to see whether index-backed search is available.\n' +
    '- If it reports no persisted data, run `codebase-index`, then use `codebase-search`.\n' +
    '- No arguments required.\n' +
    'Lightweight and safe to call frequently.',
  permission: 'auto',
  mutating: false,
  capabilities: ['fs.read'],
  // The index host has its own 30s read watchdog. Keep the outer tool budget
  // longer so the host can return a structured timeout instead of being
  // pre-empted by the generic tool executor.
  timeoutMs: 35_000,
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  async execute(_input, ctx, execOpts) {
    const signal = execOpts?.signal ?? ctx?.signal;
    signal?.throwIfAborted();

    const idxState = getIndexState();
    const indexPath = resolveIndexDir(ctx.projectRoot, codebaseIndexDirOverride(ctx));

    // The index worker can be busy parsing or writing during a startup build.
    // Do not queue a stats read merely to report progress: on large projects
    // that made this lightweight tool hit its outer timeout. Return the
    // process-local lifecycle state immediately and let callers retry later.
    if (idxState.indexing) {
      return {
        totalSymbols: 0,
        totalFiles: 0,
        byLang: {},
        byKind: {},
        lastIndexed: null,
        sizeBytes: 0,
        indexPath,
        version: SCHEMA_VERSION,
        statsAvailable: false,
        indexing: {
          currentFile: idxState.currentFile,
          totalFiles: idxState.totalFiles,
        },
        indexStatus: idxState.ready
          ? `Index refresh in progress (${idxState.currentFile}/${idxState.totalFiles} files). The persisted snapshot remains available to codebase-search; retry stats after refresh.`
          : `Startup indexing in progress (${idxState.currentFile}/${idxState.totalFiles} files). Do not start another index; retry stats or codebase-search after completion.`,
      };
    }

    // Always inspect persisted state. Readiness is process-local and resets on
    // every CLI launch, while the SQLite index intentionally survives launches.
    // Fetched via the index host (worker thread when available) — the main
    // thread never opens SQLite here.
    let stats;
    try {
      stats = await codebaseIndexStats(
        { projectRoot: ctx.projectRoot, indexDir: codebaseIndexDirOverride(ctx) },
        { signal },
      );
    } catch (err) {
      if (signal?.aborted) {
        signal.throwIfAborted();
      }
      return {
        totalSymbols: 0,
        totalFiles: 0,
        byLang: {},
        byKind: {},
        lastIndexed: null,
        sizeBytes: 0,
        indexPath,
        version: SCHEMA_VERSION,
        statsAvailable: false,
        indexStatus:
          err instanceof IndexTimeoutError || (err as Error)?.name === 'IndexTimeoutError'
            ? 'Index statistics timed out. Do not repeatedly retry stats; try codebase-search directly or use the appropriate grep/glob/tree fallback.'
            : `Index statistics query failed: ${toErrorMessage(err)}. The index may be corrupted or inaccessible; try /codebase-reindex.`,
      };
    }

    const circuit = idxState.circuit;
    const hasPersistedIndex = stats.totalFiles > 0 || stats.lastIndexed !== null;
    let indexStatus: string | undefined;
    if (circuit.state === 'open') {
      const cooldownSec = Math.max(1, Math.ceil(circuit.cooldownRemainingMs / 1000));
      indexStatus =
        `${hasPersistedIndex ? 'Indexing' : 'No persisted index data found, and indexing'} is paused after repeated failures ` +
        `(last: ${circuit.lastFailure ?? 'unknown'}); auto-retry in ` +
        `${cooldownSec}s, or run /codebase-reindex. ` +
        (hasPersistedIndex
          ? 'Stats reflect the last successful build.'
          : 'Build the index after recovery.');
    } else if (!hasPersistedIndex) {
      indexStatus =
        'No persisted index data found. Run codebase-index to build it before broad code exploration.';
    }
    return {
      totalSymbols: stats.totalSymbols,
      totalFiles: stats.totalFiles,
      byLang: stats.byLang,
      byKind: stats.byKind,
      lastIndexed: stats.lastIndexed,
      sizeBytes: stats.sizeBytes,
      indexPath: stats.indexPath,
      version: stats.version,
      statsAvailable: true,
      ...(indexStatus ? { indexStatus } : {}),
    };
  },
};

export interface CodebaseStatsOutput {
  totalSymbols: number;
  totalFiles: number;
  byLang: Record<string, number>;
  byKind: Record<string, number>;
  lastIndexed: number | null;
  sizeBytes: number;
  indexPath: string;
  version: number;
  /** False when lifecycle state was returned without opening the SQLite index. */
  statsAvailable: boolean;
  /** Present while an index build or refresh is active. */
  indexing?:
    | {
        currentFile: number;
        totalFiles: number;
      }
    | undefined;
  /** Non-empty when the index is not ready or is still building. */
  indexStatus?: string | undefined;
}
