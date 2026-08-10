import type { Tool } from '@wrongstack/core/types';
import { isIndexing, runStartupIndex } from './background-indexer.js';
import { indexCircuitBreaker } from './circuit-breaker.js';
import { codebaseIndexDirOverride } from './writer.js';

export const codebaseIndexTool: Tool<CodebaseIndexInput, CodebaseIndexOutput> = {
  name: 'codebase-index',
  category: 'Project',
  icon: 'index',
  description:
    'Build or incrementally update the project-wide symbol index. This powers fast codebase search and understanding. ' +
    'By default it only processes files that have changed since the last indexing run.',
  usageHint:
    'CREATE OR REFRESH THE SEARCH INDEX:\n\n' +
    '- When `codebase-stats` or `codebase-search` reports no persisted index, call this without arguments, then retry the search.\n' +
    '- Normal and first-time usage: call without arguments for an incremental build.\n' +
    '- Use `force: true` only for a corrupt/stale index or an explicitly requested clean rebuild.\n' +
    '- Use `langs` to restrict to specific languages if you only care about certain parts of the project.\n' +
    'This tool is relatively expensive — do not call it on every turn. Use it when the index is stale or before heavy codebase-search sessions.',
  permission: 'confirm',
  mutating: true,
  capabilities: ['fs.write.outside-project'],
  // Must comfortably exceed the index watchdog
  // (DEFAULT_FULL_INDEX_TIMEOUT_MS = 240s in background-indexer.ts) so the
  // structured IndexTimeoutError reaches the agent instead of a generic
  // TOOL_TIMEOUT.  The watchdog is armed inside withMutex, so under
  // contention from a concurrent incremental batch (60s ceiling) the tool
  // timeout must also cover the mutex queue wait + 240s watchdog + margin.
  timeoutMs: 305_000,
  inputSchema: {
    type: 'object',
    properties: {
      force: {
        type: 'boolean',
        description: 'Force a full reindex — clears the index first and reindexes all files.',
      },
      langs: {
        type: 'array',
        items: { type: 'string' },
        description: 'Limit reindex to specific languages: ts, tsx, js, jsx, go, py, rs',
      },
    },
  },
  async execute(input, ctx, execOpts) {
    // If the startup index is still running, tell the agent to wait instead of
    // firing a second reindex that would just queue behind the mutex.
    if (isIndexing()) {
      return {
        filesIndexed: 0,
        symbolsIndexed: 0,
        langStats: {},
        durationMs: 0,
        errors: [],
        note: 'A full index is already in progress. Retry codebase-index after it completes (check codebase-stats).',
      };
    }

    // Circuit breaker: after repeated failures/timeouts indexing is paused.
    // Report instead of erroring so the agent can carry on without the index.
    const circuit = indexCircuitBreaker.snapshot();
    if (circuit.state === 'open' && circuit.cooldownRemainingMs > 0) {
      return {
        filesIndexed: 0,
        symbolsIndexed: 0,
        langStats: {},
        durationMs: 0,
        errors: [],
        note:
          `Codebase indexing is paused after repeated failures (last: ${circuit.lastFailure ?? 'unknown'}). ` +
          `Auto-retry possible in ${Math.ceil(circuit.cooldownRemainingMs / 1000)}s; the user can run /codebase-reindex to retry immediately.`,
      };
    }

    // Route through the background coordinator so the run shares the
    // process-wide mutex, the watchdog timeout, and breaker accounting with
    // the startup scan and live reindexes (a direct runIndexer call here used
    // to race them on the same SQLite file).
    return await runStartupIndex({
      projectRoot: ctx.projectRoot,
      force: input.force ?? false,
      langs: input.langs,
      indexDir: codebaseIndexDirOverride(ctx),
      signal: execOpts?.signal,
    });
  },
};

// ─── Types for tool I/O ────────────────────────────────────────────────────────

interface CodebaseIndexInput {
  force?: boolean | undefined;
  langs?: string[] | undefined;
}

interface CodebaseIndexOutput {
  filesIndexed: number;
  fileOutcomes?:
    | {
        parsed: number;
        skipped: number;
        empty: number;
        failed: number;
      }
    | undefined;
  symbolsIndexed: number;
  langStats: Record<string, number>;
  durationMs: number;
  errors: string[];
  /** Advisory note when the indexer was skipped (e.g. another index in progress). */
  note?: string | undefined;
}
