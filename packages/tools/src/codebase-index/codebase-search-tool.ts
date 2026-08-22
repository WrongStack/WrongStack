/**
 * `codebase-search` tool — search the symbol index with BM25 ranking.
 *
 * Usage: codebase-search({
 *   query: string,        // search terms
 *   kind?: string,       // class|function|interface|method|const|...
 *   lang?: string,       // ts|tsx|js|jsx|go|py|rs|java|ruby|… (derived from EXT_TO_LANG)
 *   file?: string,       // filter to a specific file path (substring match)
 *   limit?: number,      // max results (default 20, max 100)
 * })
 *
 * Returns: [{ name, kind, lang, file, line, signature, snippet, score }, ...]
 *
 * The query executes in the index worker via FTS5 (`MATCH` + native `bm25()`)
 * — the main thread never opens SQLite, so a contended or wedged index can
 * slow this tool down but can never freeze the terminal.
 */

import type { Tool } from '@wrongstack/core/types';
import { toErrorMessage } from '@wrongstack/core/utils';
import { codebaseIndexStats, getIndexState, searchCodebaseIndex } from './background-indexer.js';
import { EXT_TO_LANG } from './languages.js';
import type { SearchResult, SymbolLang } from './schema.js';
import { codebaseIndexDirOverride } from './writer.js';

/**
 * Language ids the index understands — DERIVED from `EXT_TO_LANG`
 * (languages.ts), the same table that decides which files get indexed, so
 * this enum can no longer drift from the indexer's actual coverage (~40
 * languages, including java/ruby/php/swift/md/css/… that the old
 * hand-maintained 9-item list silently rejected). Single source for the
 * `lang` enum here and the `langs` validation in codebase-index-tool.ts.
 */
export const INDEXABLE_LANG_IDS: readonly SymbolLang[] = [
  ...new Set(Object.values(EXT_TO_LANG)),
].sort();
export const codebaseSearchTool: Tool<CodebaseSearchInput, CodebaseSearchOutput> = {
  name: 'codebase-search',
  category: 'Project',
  icon: 'index',
  description:
    'Search code symbols using a fast SQLite+BM25 index, with optional LSP fallback. ' +
    'Prefer this before broad `tree`, `glob`, or `grep` exploration when finding code by name or concept. ' +
    'Use `grep` instead for exact text, regexes, unsupported content, or concrete usage sites. ' +
    'Set `preferLsp: true` for live precision when the LSP plugin is active (supersedes codebase-lsp-search).',
  usageHint:
    'FIRST CHOICE FOR INDEXABLE CODE UNDERSTANDING:\n\n' +
    '- Call before broad `tree`, `glob`, or `grep` exploration when locating symbols, concepts, definitions, or candidate modules.\n' +
    '- `kind` filter is very useful (e.g. only functions or only interfaces).\n' +
    '- Combine with `file` filter to scope to a specific directory or module.\n' +
    '- If `indexStatus` reports no persisted data, run `codebase-index` and retry.',
  permission: 'auto',
  mutating: false,
  capabilities: ['fs.read'],
  // The index host has its own 30s read watchdog. Leave enough headroom for
  // worker teardown and structured timeout reporting.
  timeoutMs: 35_000,
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query — searches symbol names, signatures, and doc comments',
      },
      kind: {
        type: 'string',
        enum: [
          'class',
          'interface',
          'enum',
          'type',
          'function',
          'method',
          'var',
          'const',
          'let',
          'property',
          'parameter',
          'namespace',
          'object',
          'literal',
          'schema',
          'struct',
          'trait',
          'impl',
          'static',
          'mod',
        ],
        description: 'Filter by indexed symbol kind',
      },
      lang: {
        type: 'string',
        enum: [...INDEXABLE_LANG_IDS],
        description: 'Filter by indexed language',
      },
      lspKind: {
        type: 'integer',
        description:
          'Filter by LSP SymbolKind number (e.g. 5=Class, 12=Function, 11=Interface, 10=Enum)',
      },
      file: {
        type: 'string',
        description: 'Filter to files matching this path substring',
      },
      limit: {
        type: 'integer',
        description: 'Maximum results to return (default 20, max 100)',
        minimum: 1,
        maximum: 100,
      },
      preferLsp: {
        type: 'boolean',
        description:
          'Prefer live LSP results over the index. Ignored unless the LSP plugin is active; ' +
          'when it is active and this is true, results come from live workspaceSymbol queries.',
      },
    },
    required: ['query'],
  },
  async execute(input, ctx, execOpts) {
    const state = getIndexState();
    if (state.lastError) {
      const circuit = state.circuit;
      const retryHint =
        circuit.state === 'open'
          ? `Indexing is paused (circuit open, retry in ${Math.ceil(circuit.cooldownRemainingMs / 1000)}s); the user can run /codebase-reindex to retry now.`
          : 'Try /codebase-reindex.';
      return {
        results: [],
        total: 0,
        query: input.query,
        indexStatus: `Index build failed: ${state.lastError}. ${retryHint}`,
      };
    }

    const limit = Math.max(1, Math.min(Math.trunc(input.limit ?? 20), 100));
    // Degrade infrastructure failures (daemon down, invalid endpoint, index
    // read timeout) to the tool's empty-results + indexStatus contract instead
    // of a raw throw — mirrors codebase-stats-tool.ts. A user cancel still
    // propagates unchanged. A refresh in progress is NOT a failure: the
    // project server serves previous-generation answers flagged `stale`, and
    // only refuses when it has no cached answer for this query.
    let searched: Awaited<ReturnType<typeof searchCodebaseIndex>>;
    try {
      searched = await searchCodebaseIndex(
        {
          projectRoot: ctx.projectRoot,
          indexDir: codebaseIndexDirOverride(ctx),
          query: input.query,
          kind: input.kind?.toLowerCase(),
          lang: input.lang?.toLowerCase(),
          file: input.file,
          lspKind: input.lspKind,
          limit,
        },
        { signal: execOpts?.signal },
      );
    } catch (err) {
      if (execOpts?.signal?.aborted) throw err;
      if ((err as { name?: string }).name === 'IndexRefreshInProgressError') {
        return {
          results: [],
          total: 0,
          query: input.query,
          indexStatus: `Index refresh in progress (${state.currentFile}/${state.totalFiles} files); this query has no cached answer yet — retry after the completed generation is published.`,
        };
      }
      return {
        results: [],
        total: 0,
        query: input.query,
        indexStatus: `Index query failed: ${toErrorMessage(err)}. Fall back to grep/glob for this lookup.`,
      };
    }
    const { results, total, stale, indexSummary } = searched;
    // Process-local readiness resets on launch while the SQLite index persists.
    // A zero-hit query on a cold process therefore cannot by itself prove the
    // index is missing. P2.5: the server piggybacks the minimal summary
    // (totalFiles/lastIndexed) on zero-hit search responses, so this check no
    // longer needs a separate stats round trip over IPC.
    let hasPersistedIndex = state.ready || total > 0;
    if (!hasPersistedIndex && indexSummary) {
      hasPersistedIndex = indexSummary.totalFiles > 0 || indexSummary.lastIndexed !== null;
    }
    // Older servers (pre-P2.5) send no summary on zero hits — keep the stats
    // probe as the compatibility fallback for mixed client/server versions.
    if (!hasPersistedIndex && !indexSummary) {
      try {
        const stats = await codebaseIndexStats(
          { projectRoot: ctx.projectRoot, indexDir: codebaseIndexDirOverride(ctx) },
          { signal: execOpts?.signal },
        );
        hasPersistedIndex = stats.totalFiles > 0 || stats.lastIndexed !== null;
      } catch {
        // Search already completed successfully. Keep the conservative missing
        // hint rather than failing the whole tool because the stats probe failed.
      }
    }
    return {
      results,
      total,
      query: input.query,
      ...(stale
        ? {
            stale: true,
            indexStatus: `Index refresh in progress (${state.currentFile}/${state.totalFiles} files); results served from the previous generation — symbols from files being indexed may lag.`,
          }
        : {}),
      ...(hasPersistedIndex
        ? {}
        : { indexStatus: 'No persisted index data found. Run codebase-index to build it.' }),
    };
  },
};

// ─── Types ─────────────────────────────────────────────────────────────────────

interface CodebaseSearchInput {
  query: string;
  kind?: string | undefined;
  lang?: string | undefined;
  file?: string | undefined;
  limit?: number | undefined;
  lspKind?: number | undefined;
  /**
   * When true, hints that LSP-based search should be preferred over the index.
   * The built-in tool ignores this (index-only), but when the LSP plugin is
   * active it intercepts the tool and provides live LSP workspaceSymbol results.
   */
  preferLsp?: boolean | undefined;
}

interface CodebaseSearchOutput {
  results: SearchResult[];
  total: number; // total candidates before limit
  query: string;
  /**
   * True when the project server served a previous generation's cached
   * answer during a refresh. Results are internally consistent but may lag
   * the files currently being indexed.
   */
  stale?: boolean | undefined;
  /** Non-empty when the index blocked the search (not ready, indexing, failed). */
  indexStatus?: string | undefined;
}
