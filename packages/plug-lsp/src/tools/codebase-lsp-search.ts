/**
 * `codebase-lsp-search` — index-first, LSP-fallback symbol search.
 *
 * Architecture:
 *  1. Query the codebase index through its host (FTS5 in the index worker —
 *     this process's main thread never opens SQLite)
 *  2. If index has 0 results OR preferLsp=true, fall back to live LSP workspaceSymbol queries
 *  3. Deduplicate results present in both sources
 */

import type { Tool } from '@wrongstack/core/types';
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
import { stringifyToolError, type ToolDeps } from './shared.js';

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
      'DEPRECATED — use `codebase-search` with `preferLsp: true` instead. ' +
      'This tool remains for backward compatibility but is superseded by the built-in codebase-search tool.',
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
      try {
        const limit = Math.min(input.limit ?? 20, 100);
        const query = input.query ?? '';

        const signal = opts?.signal ?? ctx?.signal;
        let indexResults: CodebaseLspResult[] = [];
        let totalIndex = 0;
        let usedIndex = false;
        let usedLsp = false;
        let lspResults: CodebaseLspResult[] = [];
        let totalLsp = 0;

        // ── Step 1: Query index (unless preferLsp is set) ──────────────────────
        if (!input.preferLsp) {
          const indexOutcome = await searchIndex(
            ctx.projectRoot,
            query,
            limit,
            codebaseIndexDirOverride(ctx),
          );
          indexResults = indexOutcome.results;
          totalIndex = indexOutcome.total;
          usedIndex = true;
        }

        // ── Step 2: LSP fallback ───────────────────────────────────────────────
        // Fall back to LSP when:
        //  - preferLsp is true (user wants live data), OR
        //  - index returned 0 results
        const needsLsp = input.preferLsp || indexResults.length === 0;

        if (needsLsp) {
          const lspOutcome = await searchLsp(deps, query, limit, signal);
          lspResults = lspOutcome.results;
          totalLsp = lspOutcome.total;
          usedLsp = true;
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
        return stringifyToolError(err);
      }
    },
  };
}

// ─── Index search ─────────────────────────────────────────────────────────────

async function searchIndex(
  projectRoot: string,
  query: string,
  limit: number,
  indexDir?: string | undefined,
): Promise<{ results: CodebaseLspResult[]; total: number }> {
  // Ranked FTS5 query via the index host — runs in the index worker thread
  // when available, so a contended index can never block this process.
  const { results, total } = await searchCodebaseIndex({ projectRoot, indexDir, query, limit });

  return {
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
): Promise<{ results: CodebaseLspResult[]; total: number }> {
  const merged: SymbolInformation[] = [];

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
          if (result) {
            for (const sym of result) {
              merged.push(sym);
            }
          }
        } catch {
          // Individual server errors are non-fatal; skip this server's results
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
      file: sym.location.uri.startsWith('file://')
        ? sym.location.uri.slice(7) // strip "file://"
        : sym.location.uri,
      line: sym.location.range.start.line + 1, // convert to 1-based
      source: 'lsp' as const,
      server: serverNameFromConfig(deps, sym),
    })),
  );

  return {
    results: deduplicated.slice(0, limit),
    total: deduplicated.length,
  };
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
