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
import { ToolValidationError } from '@wrongstack/core/types';
import { toErrorMessage } from '@wrongstack/core/utils';
import { codebaseIndexStats, getIndexState, incomingCallsService } from './background-indexer.js';
import { serializeCallSites } from './call-site-serializer.js';
import type { CallSite } from './schema.js';
import { codebaseIndexDirOverride } from './writer.js';

export const codebaseIncomingCallsTool: Tool<IncomingCallsInput, IncomingCallsOutput> = {
  name: 'codebase-incoming-calls',
  serialize: serializeCallSites,
  category: 'Project',
  icon: 'index',
  description:
    'Find all callers of a function, method, or symbol — who invokes or references it. ' +
    'Uses the codebase index ref graph for instant, exact results. ' +
    'Prefer this over grep for change-impact checks when the index is available.',
  usageHint:
    'CALL THIS BEFORE REFACTORING OR CHANGING ANY FUNCTION:\n\n' +
    '- Prefer this over grep when the index is available; fall back to grep when the index is cold/unavailable or for dynamic dispatch the ref graph cannot see.\n' +
    '- Call codebase-incoming-calls({ symbol: "funcName" }) before editing the symbol.\n' +
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
      transitive: {
        type: 'boolean',
        description:
          'When true, traverse the full transitive call chain (callers of callers, to unlimited depth). ' +
          'Default false: return only direct callers. Cycle-safe via SQL recursive CTE.',
        default: false,
      },
    },
    required: ['symbol'],
  },
  async execute(input, ctx) {
    if (!input?.symbol || typeof input.symbol !== 'string' || !input.symbol.trim()) {
      throw new ToolValidationError({
        message: 'codebase-incoming-calls: symbol is required and cannot be empty',
        field: 'symbol',
      });
    }

    const state = getIndexState();
    if (state.lastError) {
      const circuit = state.circuit;
      const retryHint =
        circuit.state === 'open'
          ? `Indexing is paused (circuit open, retry in ${Math.ceil(circuit.cooldownRemainingMs / 1000)}s).`
          : 'Try /codebase-reindex.';
      throw new Error(`Index build failed: ${state.lastError}. ${retryHint}`);
    }

    const rawLimit =
      typeof input.limit === 'number' && Number.isFinite(input.limit) ? input.limit : 50;
    const limit = Math.max(1, Math.min(Math.trunc(rawLimit), 200));
    const transitive = input.transitive === true;
    // Infrastructure failures (daemon down, invalid endpoint, index read
    // timeout, never-built index) THROW: an empty `calls` payload read as
    // "no callers" — exactly the wrong conclusion before a refactor. A
    // refresh with a cached answer is served `stale`; without one the server
    // refuses and that refusal is a failure too.
    const projectRoot = ctx.projectRoot ?? ctx.cwd ?? process.cwd();
    let serviced: Awaited<ReturnType<typeof incomingCallsService>>;
    try {
      serviced = await incomingCallsService({
        projectRoot,
        indexDir: codebaseIndexDirOverride(ctx),
        symbol: input.symbol,
        file: input.file,
        limit,
        transitive,
      });
    } catch (err) {
      if ((err as { name?: string }).name === 'IndexRefreshInProgressError') {
        throw new Error(
          `Index refresh in progress (${state.currentFile}/${state.totalFiles} files); this symbol has no cached answer yet — retry after the completed generation is published.`,
          { cause: err },
        );
      }
      throw new Error(
        `Index query failed: ${toErrorMessage(err)}. Fall back to grep for this lookup.`,
        { cause: err },
      );
    }
    const { calls, symbolFound, ambiguous, totalMatches, stale } = serviced;

    if (!symbolFound) {
      // Process-local readiness resets on launch while the SQLite index may
      // never have been built. Probe persisted stats before blaming the symbol
      // name — otherwise a cold, never-indexed project gets a misleading
      // "not found in the index" note (mirrors codebase-search-tool.ts).
      let hasPersistedIndex = state.ready;
      if (!hasPersistedIndex) {
        try {
          const stats = await codebaseIndexStats({
            projectRoot,
            indexDir: codebaseIndexDirOverride(ctx),
          });
          hasPersistedIndex = stats.totalFiles > 0 || stats.lastIndexed !== null;
        } catch (err) {
          throw new Error(
            `Symbol "${input.symbol}" was not found and the persisted index could not be verified: ${toErrorMessage(err)}. Try /codebase-reindex or fall back to grep.`,
            { cause: err },
          );
        }
      }
      if (!hasPersistedIndex) {
        throw new Error(
          'No persisted index data found. Run codebase-index to build it, then retry.',
        );
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
    if (ambiguous) {
      notes.push(
        `Symbol "${input.symbol}" exists in multiple files. Callers resolved to another file were excluded, but callers whose target could not be pinned to a file are still included. Verify with codebase-search before relying on the list.`,
      );
    }
    if (stale) {
      notes.push(
        `Index refresh in progress (${state.currentFile}/${state.totalFiles} files); callers served from the previous generation — call sites in files being indexed may lag.`,
      );
    }

    return {
      symbol: input.symbol,
      calls,
      total: calls.length,
      ...(stale ? { stale: true } : {}),
      ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
    };
  },
};

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface IncomingCallsInput {
  symbol: string;
  file?: string | undefined;
  limit?: number | undefined;
  transitive?: boolean | undefined;
}

export type CodebaseIncomingCallsInput = IncomingCallsInput;

export interface IncomingCallsOutput {
  symbol: string;
  calls: CallSite[];
  total: number;
  /**
   * True when the project server served a previous generation's cached
   * answer during a refresh. Results are internally consistent but may lag
   * the files currently being indexed.
   */
  stale?: boolean | undefined;
  /** Advisory note when the symbol was not found in the index. */
  note?: string | undefined;
}

export type CodebaseIncomingCallsOutput = IncomingCallsOutput;
