/**
 * `codebase-incoming-calls` tool — find all callers/users of a symbol.
 *
 * Usage: codebase-incoming-calls({
 *   symbol: string,        // function/method/type name to look up
 *   file?: string,         // scope to one file when multiple symbols share a name
 *   limit?: number,        // max results (default 50, max 200)
 * })
 *
 * Returns: [{ symbol: { name, kind, file, line, signature }, callType, line }, ...]
 *
 * The query executes against the SQLite index's refs graph — it resolves the
 * symbol name to IDs, then finds every ref edge pointing TO those IDs. The
 * result carries the caller's full metadata so no second lookup is needed.
 */

import type { Tool } from '@wrongstack/core/types';
import {
  codebaseIndexStats,
  getIndexState,
  incomingCallsService,
} from './background-indexer.js';
import type { CallSite } from './schema.js';
import { codebaseIndexDirOverride } from './writer.js';

export const codebaseIncomingCallsTool: Tool<IncomingCallsInput, IncomingCallsOutput> = {
  name: 'codebase-incoming-calls',
  category: 'Project',
  icon: 'index',
  description:
    'Find all callers of a function, method, or symbol — who invokes or references it. ' +
    'Uses the codebase index ref graph for instant, exact results. ' +
    'Always use this instead of grep when checking impact of a change.',
  usageHint:
    'CALL THIS BEFORE REFACTORING OR CHANGING ANY FUNCTION:\n\n' +
    '- NEVER use grep or manual line reading to check where a function is called.\n' +
    '- ALWAYS call codebase-incoming-calls({ symbol: "funcName" }) first.\n' +
    '- Returns exact files, line numbers, caller signatures, and call types in milliseconds.\n' +
    '- Use `file` to disambiguate when multiple symbols share a name.\n' +
    '- Combine with codebase-outgoing-calls to see what the symbol itself calls.\n' +
    'If the index is not built, run codebase-index first.',
  permission: 'auto',
  mutating: false,
  capabilities: ['fs.read'],
  timeoutMs: 35_000,
  inputSchema: {
    type: 'object',
    properties: {
      symbol: {
        type: 'string',
        description: 'The function/method/type name to find callers for',
      },
      file: {
        type: 'string',
        description: 'Scope to a specific file when multiple symbols share the same name',
      },
      limit: {
        type: 'integer',
        description: 'Maximum call sites to return (default 50, max 200)',
        minimum: 1,
        maximum: 200,
      },
    },
    required: ['symbol'],
  },
  async execute(input, ctx) {
    const state = getIndexState();
    if (state.indexing && !state.ready) {
      return {
        symbol: input.symbol,
        calls: [],
        total: 0,
        indexStatus: `Indexing in progress (${state.currentFile}/${state.totalFiles} files) — retry in a moment.`,
      };
    }
    if (state.lastError) {
      const circuit = state.circuit;
      const retryHint =
        circuit.state === 'open'
          ? `Indexing is paused (circuit open, retry in ${Math.ceil(circuit.cooldownRemainingMs / 1000)}s).`
          : 'Try /codebase-reindex.';
      return {
        symbol: input.symbol,
        calls: [],
        total: 0,
        indexStatus: `Index build failed: ${state.lastError}. ${retryHint}`,
      };
    }

    const limit = Math.max(1, Math.min(Math.trunc(input.limit ?? 50), 200));
    const { calls, symbolFound, ambiguous, totalMatches } = await incomingCallsService(
      {
        projectRoot: ctx.projectRoot,
        indexDir: codebaseIndexDirOverride(ctx),
        symbol: input.symbol,
        file: input.file,
        limit,
      },
    );

    if (!symbolFound) {
      // Process-local readiness resets on launch while the SQLite index may
      // never have been built. Probe persisted stats before blaming the symbol
      // name — otherwise a cold, never-indexed project gets a misleading
      // "not found in the index" note (mirrors codebase-search-tool.ts).
      let hasPersistedIndex = state.ready;
      if (!hasPersistedIndex) {
        try {
          const stats = await codebaseIndexStats({
            projectRoot: ctx.projectRoot,
            indexDir: codebaseIndexDirOverride(ctx),
          });
          hasPersistedIndex = stats.totalFiles > 0 || stats.lastIndexed !== null;
        } catch {
          // Keep the conservative missing-index hint rather than failing the
          // whole tool because the stats probe failed.
        }
      }
      if (!hasPersistedIndex) {
        return {
          symbol: input.symbol,
          calls: [],
          total: 0,
          indexStatus: 'No persisted index data found. Run codebase-index to build it.',
        };
      }
      return {
        symbol: input.symbol,
        calls: [],
        total: 0,
        note: `Symbol "${input.symbol}" not found in the index. Use codebase-search to verify the name.`,
      };
    }

    const notes: string[] = [];
    if (totalMatches > limit) {
      notes.push(`Results capped at ${limit} of ${totalMatches} call sites. Increase \`limit\` or use \`file\` to narrow.`);
    }
    if (ambiguous) {
      notes.push(`Symbol "${input.symbol}" exists in multiple files. Results include callers of all same-named symbols. Use codebase-search to find the exact file and pass it as \`file\`.`);
    }

    return {
      symbol: input.symbol,
      calls,
      total: calls.length,
      ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
    };
  },
};

// ─── Types ─────────────────────────────────────────────────────────────────────

interface IncomingCallsInput {
  symbol: string;
  file?: string | undefined;
  limit?: number | undefined;
}

interface IncomingCallsOutput {
  symbol: string;
  calls: CallSite[];
  total: number;
  /** Non-empty when the index blocked the query (not ready, indexing, failed). */
  indexStatus?: string | undefined;
  /** Advisory note when the symbol was not found in the index. */
  note?: string | undefined;
}
