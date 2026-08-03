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
import {
  getIndexState,
  outgoingCallsService,
} from './background-indexer.js';
import type { CallSite } from './schema.js';
import { codebaseIndexDirOverride } from './writer.js';

export const codebaseOutgoingCallsTool: Tool<OutgoingCallsInput, OutgoingCallsOutput> = {
  name: 'codebase-outgoing-calls',
  category: 'Project',
  icon: 'index',
  description:
    'Find all functions/methods/symbols that a given symbol calls or depends on — its callees. ' +
    'Uses the codebase index ref graph for instant, exact results. ' +
    'Use this to understand a function\'s dependencies before modifying it.',
  usageHint:
    'USE THIS TO UNDERSTAND A FUNCTION\'S DEPENDENCIES:\n\n' +
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
    const { calls, symbolFound, unresolvedCount } = await outgoingCallsService(
      {
        projectRoot: ctx.projectRoot,
        indexDir: codebaseIndexDirOverride(ctx),
        symbol: input.symbol,
        file: input.file,
        limit,
      },
    );

    if (!symbolFound) {
      return {
        symbol: input.symbol,
        calls: [],
        total: 0,
        note: `Symbol "${input.symbol}" not found in the index. Use codebase-search to verify the name.`,
      };
    }

    return {
      symbol: input.symbol,
      calls,
      total: calls.length,
      ...(unresolvedCount > 0
        ? { note: `${unresolvedCount} unresolved reference(s) not shown — their targets could not be resolved during indexing.` }
        : {}),
    };
  },
};

// ─── Types ─────────────────────────────────────────────────────────────────────

interface OutgoingCallsInput {
  symbol: string;
  file?: string | undefined;
  limit?: number | undefined;
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
