/**
 * `codebase-lsp-search` — index-first, LSP-fallback symbol search.
 *
 * Architecture:
 *  1. Query the codebase index through its host (FTS5 in the index worker —
 *     this process's main thread never opens SQLite)
 *  2. If index has 0 results OR preferLsp=true, fall back to live LSP workspaceSymbol queries
 *  3. Deduplicate results present in both sources
 */

import type { Tool } from '@wrongstack/contracts/types';
import { ToolValidationError } from '@wrongstack/contracts/types';
import {
  codebaseIndexDirOverride,
  internalKindToLspKind,
  lspKindToInternalKind,
  searchCodebaseIndex,
} from '@wrongstack/tools/codebase-index/index';
import type { SymbolInformation } from 'vscode-languageserver-protocol';

import { LSP_CONSTANTS } from '../constants.js';
import { formatCodebaseLspResults } from '../formatters/symbols.js';
import { supportsWorkspaceSymbol } from '../server/capabilities.js';
import { LSPError, LSPErrorCode } from '../types.js';
import { uriToPath } from '../utils/uri.js';
import { type ToolDeps, toToolError } from './shared.js';

// ─── Input / Output types ───────────────────────────────────────────────────────

interface CodebaseLspSearchInput {
  query: string;
  limit?: number | undefined;
  preferLsp?: boolean | undefined;
}

interface CodebaseLspResult {
  name: string;
  kind: string;
  lspKind: number;
  file: string;
  line: number;
  source: 'index' | 'lsp';
  server?: string | undefined;
  score?: number | undefined;
  snippet?: string | undefined;
}

interface CodebaseLspSearchOutput {
  results: CodebaseLspResult[];
  totalIndex: number;
  totalLsp: number;
  query: string;
  usedIndex: boolean;
  usedLsp: boolean;
}

// ─── Tool factory ──────────────────────────────────────────────────────────────

export function createCodebaseLspSearchTool(deps: ToolDeps): Tool<CodebaseLspSearchInput, string> {
  return {
    name: 'codebase-lsp-search',
    description:
      'Search code symbols through the index with a live LSP workspace-symbol fallback. Use preferLsp=true when current language-server state matters more than the persisted index.',
    usageHint:
      'Pass `query` to search. Use `limit` (default 20) to cap results. Set `preferLsp=true` to skip the index and query LSP servers directly for live precision.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query string' },
        limit: {
          type: 'integer',
          description: 'Maximum number of results to return (default 20, max 100)',
          minimum: 1,
          maximum: 100,
        },
        preferLsp: {
          type: 'boolean',
          description:
            'If true, skip the index and query LSP servers directly. Useful for live precision when the index may be stale.',
        },
      },
      required: ['query'],
    },
    permission: 'auto',
    mutating: false,
    timeoutMs: LSP_CONSTANTS.TOOL_TIMEOUT_MS * 2, // Allow extra time for LSP round-robins
    async execute(input, ctx, opts) {
      const query = typeof input.query === 'string' ? input.query.trim() : '';
      if (!query) {
        throw new ToolValidationError({
          message: 'codebase-lsp-search: query is required and cannot be empty',
          field: 'query',
        });
      }
      try {
        // 0/negative made `slice(0, limit)` drop results from the END; NaN
        // returned nothing at all.
        const requested = Number.isFinite(input.limit) ? Math.trunc(input.limit as number) : 20;
        const limit = Math.min(Math.max(requested, 1), 100);

        const signal = opts?.signal ?? ctx?.signal;
        let indexResults: CodebaseLspResult[] = [];
        let totalIndex = 0;
        let usedIndex = false;
        let usedLsp = false;
        let lspResults: CodebaseLspResult[] = [];
        let totalLsp = 0;
        // Why the index could not answer (outage or never built). Only fatal
        // when LSP cannot answer either — otherwise "no symbols" would hide it.
        let indexUnavailable: string | undefined;

        // ── Step 1: Query index (unless preferLsp is set) ──────────────────────
        if (!input.preferLsp) {
          try {
            const indexOutcome = await searchIndex(
              ctx.projectRoot,
              query,
              limit,
              codebaseIndexDirOverride(ctx),
              signal,
            );
            indexResults = indexOutcome.results;
            totalIndex = indexOutcome.total;
            usedIndex = true;
            if (indexOutcome.missing) {
              indexUnavailable = 'no persisted codebase index (run codebase-index)';
            }
          } catch (err) {
            if (signal?.aborted) throw err;
            indexUnavailable = `index query failed: ${err instanceof Error ? err.message : String(err)}`;
          }
        }

        // ── Step 2: LSP fallback ───────────────────────────────────────────────
        // Fall back to LSP when:
        //  - preferLsp is true (user wants live data), OR
        //  - index returned 0 results (or could not be queried)
        const needsLsp = input.preferLsp || indexResults.length === 0;

        if (needsLsp) {
          const lspOutcome = await searchLsp(deps, query, limit, signal);
          lspResults = lspOutcome.results;
          totalLsp = lspOutcome.total;
          usedLsp = true;
          // No server answered: an empty result would read as "no symbols"
          // while nothing was actually searched.
          if (lspOutcome.answered === 0 && (input.preferLsp || indexUnavailable)) {
            const lspReason =
              lspOutcome.failures.length > 0
                ? `every LSP workspace-symbol request failed (${lspOutcome.failures.join('; ')})`
                : 'no ready LSP server supports workspace symbols';
            throw new LSPError(
              LSPErrorCode.ServerNotReady,
              `codebase-lsp-search could not search: ${[indexUnavailable, lspReason].filter(Boolean).join('; ')}`,
            );
          }
        }

        // ── Step 3: Merge & deduplicate ────────────────────────────────────────
        const output = mergeResults(indexResults, lspResults, limit);

        const fullOutput: CodebaseLspSearchOutput = {
          results: output,
          totalIndex,
          totalLsp,
          query,
          usedIndex,
          usedLsp,
        };

        return formatCodebaseLspResults(fullOutput, ctx.cwd);
      } catch (err) {
        throw toToolError(err);
      }
    },
  };
}

// ─── Index search ─────────────────────────────────────────────────────────────

async function searchIndex(
  projectRoot: string,
  query: string,
  limit: number,
  indexDir: string | undefined,
  signal: AbortSignal | undefined,
): Promise<{ results: CodebaseLspResult[]; total: number; missing: boolean }> {
  // Ranked FTS5 query via the index host — runs in the index worker thread
  // when available, so a contended index can never block this process.
  const { results, total, indexSummary } = await searchCodebaseIndex(
    { projectRoot, indexDir, query, limit },
    { signal },
  );

  return {
    // Zero-hit responses carry the index summary: an empty, never-built index
    // is not the same answer as "no symbol matched".
    missing:
      total === 0 &&
      indexSummary !== undefined &&
      indexSummary.totalFiles === 0 &&
      indexSummary.lastIndexed === null,
    results: results.map((c) => ({
      name: c.name,
      kind: c.kind,
      lspKind: internalKindToLspKind(c.kind) ?? 0,
      file: c.file,
      line: c.line,
      source: 'index' as const,
      score: c.score,
      snippet: c.snippet,
    })),
    total,
  };
}

// ─── LSP search ───────────────────────────────────────────────────────────────

async function searchLsp(
  deps: ToolDeps,
  query: string,
  limit: number,
  signal: AbortSignal,
): Promise<{
  results: CodebaseLspResult[];
  total: number;
  /** Servers whose request completed (with or without hits). */
  answered: number;
  failures: string[];
}> {
  const merged: SymbolInformation[] = [];
  let answered = 0;
  const failures: string[] = [];

  await deps.registry.ensureProjectServersReady(signal);
  const servers = deps.registry.list();
  const promises: Array<Promise<void>> = [];

  for (const server of servers) {
    if (server.state !== 'ready') continue;
    if (server.capabilities && !supportsWorkspaceSymbol(server.capabilities)) continue;

    promises.push(
      (async () => {
        try {
          const result = await server.workspaceSymbol(
            { query },
            LSP_CONSTANTS.TOOL_TIMEOUT_MS,
            signal,
          );
          answered++;
          if (result) {
            for (const sym of result) {
              merged.push(sym);
            }
          }
        } catch (err) {
          // One server failing is non-fatal while another answers; the caller
          // decides when "nobody answered" is an error.
          if (signal?.aborted) throw err;
          failures.push(`${server.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      })(),
    );
  }

  await Promise.all(promises);

  const deduplicated = deduplicateByKey(
    merged.map((sym) => ({
      name: sym.name,
      kind: lspKindToInternalKind(sym.kind) ?? 'symbol',
      lspKind: sym.kind,
      file: locationUriToPath(sym.location.uri),
      line: sym.location.range.start.line + 1, // convert to 1-based
      source: 'lsp' as const,
      server: serverNameFromConfig(deps, sym),
    })),
  );

  return {
    results: deduplicated.slice(0, limit),
    total: deduplicated.length,
    answered,
    failures,
  };
}

/**
 * Convert a server-provided symbol location URI to a filesystem path.
 * `fileURLToPath` (unlike `.slice(7)`) handles Windows drive letters and
 * percent-escapes; degenerate URIs it rejects (e.g. a drive-less
 * `file:///x.ts` on Windows) come back unchanged rather than losing the whole
 * search to a thrown tool call.
 */
function locationUriToPath(uri: string): string {
  if (!uri.startsWith('file:')) return uri;
  try {
    return uriToPath(uri);
  } catch {
    return uri;
  }
}

function serverNameFromConfig(deps: ToolDeps, sym: SymbolInformation): string {
  // Try to find which server owns this file by its language
  // Heuristic: look at file extension
  const file = sym.location.uri;
  const ext = file.includes('.') ? (file.split('.').pop()?.toLowerCase() ?? '') : '';

  const langMap: Record<string, string[]> = {
    ts: ['typescript', 'tsserver'],
    tsx: ['typescript', 'tsserver'],
    js: ['javascript', 'typescript'],
    jsx: ['javascript', 'typescript'],
    py: ['python', 'pyright'],
    go: ['go', 'gopls'],
    rs: ['rust', 'rust-analyzer'],
  };

  const langs = langMap[ext] ?? [ext];
  const servers = deps.registry.list();

  for (const lang of langs) {
    for (const server of servers) {
      if (
        server.state === 'ready' &&
        server.config.languages.some((l) => l.toLowerCase() === lang.toLowerCase())
      ) {
        return server.name;
      }
    }
  }

  // Fallback: return first ready server
  return servers.find((s) => s.state === 'ready')?.name ?? 'unknown';
}

// ─── Merge & deduplication ────────────────────────────────────────────────────

function mergeResults(
  indexResults: CodebaseLspResult[],
  lspResults: CodebaseLspResult[],
  limit: number,
): CodebaseLspResult[] {
  const seen = new Map<string, CodebaseLspResult>();

  // Index results take priority (BM25-ranked)
  for (const r of indexResults) {
    const key = `${r.file}:${r.line}:${r.name}`;
    seen.set(key, r);
  }

  // LSP results fill in gaps (deduplicated)
  for (const r of lspResults) {
    const key = `${r.file}:${r.line}:${r.name}`;
    if (!seen.has(key)) {
      seen.set(key, r);
    }
  }

  // Sort: index results first (already ranked), then LSP results
  const merged = Array.from(seen.values());
  merged.sort((a, b) => {
    if (a.source === 'index' && b.source !== 'index') return -1;
    if (a.source !== 'index' && b.source === 'index') return 1;
    // Within same source, prefer higher score
    if (a.source === 'index' && b.source === 'index') {
      return (b.score ?? 0) - (a.score ?? 0);
    }
    return 0;
  });

  return merged.slice(0, limit);
}

function deduplicateByKey<T extends { name: string; file: string; line: number }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.file}:${item.line}:${item.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
