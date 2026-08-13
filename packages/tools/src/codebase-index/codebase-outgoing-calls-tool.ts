/**
 * `codebase-outgoing-calls` tool — find all callees/dependencies of a symbol.
 *
 * Usage: codebase-outgoing-calls({
 *   symbol: string,        // function/method/type name to look up
 *   file?: string,         // scope to one file when multiple symbols share a name
 *   limit?: number,        // max results (default 50, max 200)
 * })
 *
 * Returns: [{ symbol: { name, kind, file, line, signature }, callType, line }, ...]
 *
 * The query executes against the SQLite index's refs graph — it resolves the
 * symbol name to IDs, then finds every ref edge going FROM those IDs. The
 * result carries the callee's full metadata so no second lookup is needed.
 */

import type { Tool } from '@wrongstack/core/types';
import { toErrorMessage } from '@wrongstack/core/utils';
import { codebaseIndexStats, getIndexState, outgoingCallsService } from './background-indexer.js';
import type { CallSite } from './schema.js';
import { codebaseIndexDirOverride } from './writer.js';

export const codebaseOutgoingCallsTool: Tool<OutgoingCallsInput, OutgoingCallsOutput> = {
  name: 'codebase-outgoing-calls',
  category: 'Project',
  icon: 'index',
  description:
    'Find all functions/methods/symbols that a given symbol calls or depends on — its callees. ' +
    'Uses the codebase index ref graph for instant, exact results. ' +
    "Use this to understand a function's dependencies before modifying it.",
  usageHint:
    "USE THIS TO UNDERSTAND A FUNCTION'S DEPENDENCIES:\n\n" +
    '- Prefer this over grep when the index is available; fall back to grep when the index is cold/unavailable or for dynamic dispatch the ref graph cannot see.\n' +
    '- Call codebase-outgoing-calls({ symbol: "funcName" }) to see everything it calls.\n' +
    '- Returns exact files, line numbers, callee signatures, and call types in milliseconds.\n' +
    '- Use `file` to disambiguate when multiple symbols share a name.\n' +
    '- Pair with codebase-incoming-calls for a complete impact picture: incoming = who calls you, outgoing = what you call.\n' +
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
        description: 'The function/method/type name to find callees for',
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
      transitive: {
        type: 'boolean',
        description:
          'When true, traverse the full transitive dependency chain (callees of callees, to unlimited depth). ' +
          'Default false: return only direct callees. Cycle-safe via SQL recursive CTE.',
        default: false,
      },
    },
    required: ['symbol'],
  },
  async execute(input, ctx) {
    const state = getIndexState();
    if (state.indexing) {
      return {
        symbol: input.symbol,
        calls: [],
        total: 0,
        indexStatus: `Index refresh in progress (${state.currentFile}/${state.totalFiles} files) — retry after the completed generation is published.`,
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
    const transitive = input.transitive === true;
    // Degrade infrastructure failures (daemon down, invalid endpoint, index
    // read timeout) to the empty-results + indexStatus contract instead of a
    // raw throw — mirrors codebase-search-tool.ts / codebase-stats-tool.ts.
    let serviced: Awaited<ReturnType<typeof outgoingCallsService>>;
    try {
      serviced = await outgoingCallsService({
        projectRoot: ctx.projectRoot,
        indexDir: codebaseIndexDirOverride(ctx),
        symbol: input.symbol,
        file: input.file,
        limit,
        transitive,
      });
    } catch (err) {
      return {
        symbol: input.symbol,
        calls: [],
        total: 0,
        indexStatus: `Index query failed: ${toErrorMessage(err)}. Fall back to grep for this lookup.`,
      };
    }
    const { calls, symbolFound, unresolvedCount, totalMatches } = serviced;

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
      notes.push(
        `Results capped at ${limit} of ${totalMatches} call sites. Increase \`limit\` or use \`file\` to narrow.`,
      );
    }
    if (unresolvedCount > 0) {
      notes.push(
        `${unresolvedCount} unresolved reference(s) not shown — their targets could not be resolved during indexing.`,
      );
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

interface OutgoingCallsInput {
  symbol: string;
  file?: string | undefined;
  limit?: number | undefined;
  transitive?: boolean | undefined;
}

interface OutgoingCallsOutput {
  symbol: string;
  calls: CallSite[];
  total: number;
  /** Non-empty when the index blocked the query (not ready, indexing, failed). */
  indexStatus?: string | undefined;
  /** Advisory note when the symbol was not found, or unresolved refs exist. */
  note?: string | undefined;
}
