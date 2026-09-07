/**
 * `codebase-context` tool — one call that answers "which files does this task
 * touch, and what is in them?".
 *
 * The index already exposed the ingredients: `codebase-search` finds symbols
 * by name, `codebase-skeleton` shows a file's shape, `codebase-incoming-calls`
 * finds callers. Composing them was left to the model, which meant re-deriving
 * the same chain on every task and spending several round trips on plumbing.
 * This tool runs the composition server-side: lexical search seeds a
 * personalised PageRank walk over the reference graph, and what comes back is
 * the ranked file set with the declarations that matter in each.
 *
 * It deliberately returns signatures and line numbers rather than source. The
 * point is to make the subsequent `read` land in the right place, not to
 * replace it — inlining bodies here would spend the caller's context on code
 * they may not need.
 */

import type { Tool } from '@wrongstack/core/types';
import { ToolValidationError } from '@wrongstack/core/types';
import { toErrorMessage } from '@wrongstack/core/utils';
import { codebaseContext, codebaseVectorSearch } from './background-indexer.js';
import type { ContextEntry } from './context-retrieval.js';
import type { EmbeddingPort } from './embedding-pass.js';
import { codebaseIndexDirOverride } from './writer.js';

export interface CodebaseContextInput {
  /** What you are trying to do or understand, in plain words. */
  query: string;
  /** Files to return. Defaults to 12, capped at 50. */
  limit?: number | undefined;
  /** Declarations shown per file. Defaults to 4, capped at 20. */
  symbolsPerFile?: number | undefined;
  /** Restrict results to a project-relative path prefix. */
  pathPrefix?: string | undefined;
}

export interface CodebaseContextOutput {
  query: string;
  entries: ContextEntry[];
  /** Lexical hits that seeded the walk. */
  seedCount: number;
  /** Semantic hits that also seeded it. Zero without an embedding model. */
  semanticSeedCount: number;
  /** Files the walk reached before truncation to `limit`. */
  totalCandidates: number;
  /**
   * `ok` — a ranked answer. `no-index` — nothing indexed yet.
   * `no-matches` — the index exists but the query matched nothing.
   * `unranked` — symbols exist but no reference graph, so results are lexical
   * only. `error` — the lookup itself failed; see `error`.
   */
  indexStatus: 'ok' | 'no-index' | 'no-matches' | 'unranked' | 'error';
  /** True when a cached answer from a previous generation was served. */
  stale?: boolean | undefined;
  error?: string | undefined;
}

/** The host watchdog cancels at 30s; ask for slightly more so it wins. */
const TOOL_TIMEOUT_MS = 35_000;

/** Semantically nearest files fed into the walk as extra restart mass. */
const VECTOR_HIT_LIMIT = 12;

/**
 * Cosine floor for a semantic hit. Below this the nearest neighbour is just
 * the nearest of a bad lot, and adding it as restart mass only blurs the walk.
 */
const VECTOR_MIN_SCORE = 0.25;

/**
 * Process-wide embedding model for query-time semantic search.
 *
 * Set by the host, because the model is an optional native dependency that
 * `packages/tools` must not require — and because a function cannot cross the
 * project daemon's IPC boundary, so the query is embedded here and only the
 * resulting file scores are sent. Unset simply means lexical-only retrieval.
 */
let queryEmbedder: EmbeddingPort | undefined;

/** Install (or clear) the query-time embedding model. */
export function setContextQueryEmbedder(port: EmbeddingPort | undefined): void {
  queryEmbedder = port;
}

/**
 * Embed the query and find the semantically nearest files.
 *
 * Never throws: semantic search is an enhancement over a working lexical
 * path, so a model that is missing, slow, or broken costs the query its
 * semantic seeds and nothing else.
 */
async function semanticSeeds(
  projectRoot: string,
  indexDir: string | undefined,
  query: string,
): Promise<Array<{ file: string; score: number }>> {
  const port = queryEmbedder;
  if (port === undefined) return [];
  try {
    const [vector] = await port.embed([query]);
    if (vector === undefined || vector.length !== port.dimensions) return [];
    const result = await codebaseVectorSearch({
      projectRoot,
      indexDir,
      vector: Array.from(vector),
      limit: VECTOR_HIT_LIMIT,
      minScore: VECTOR_MIN_SCORE,
    });
    return result.hits;
  } catch {
    return [];
  }
}

export const codebaseContextTool: Tool<CodebaseContextInput, CodebaseContextOutput> = {
  name: 'codebase-context',
  category: 'Project',
  icon: 'index',
  permission: 'auto',
  mutating: false,
  capabilities: ['fs.read'],
  timeoutMs: TOOL_TIMEOUT_MS,
  description:
    'Find the files and declarations a task touches, from a plain-language description. ' +
    'Combines ranked symbol search with a personalised walk over the reference graph, so results include ' +
    'not just what matched by name but what those matches are structurally attached to — the interface behind ' +
    'a handler, the store behind a route, the module every match imports. ' +
    'Returns ranked files with the relevant declarations, their signatures and line numbers.',
  usageHint:
    'START HERE FOR ANY TASK THAT SPANS MORE THAN ONE FILE:\n\n' +
    '- Describe the task, not a symbol name: `codebase-context({ query: "retry a provider request after a 429" })`.\n' +
    '- Prefer this over `codebase-search` when you do not already know the symbol you want; prefer `codebase-search` when you do.\n' +
    '- Use the returned `file` + `line` to `read` only the parts you need, instead of reading whole files.\n' +
    '- `matched: true` means the file matched the query directly; the rest were reached through the graph.\n' +
    '- `relevance` is relative to this answer only (top result is always 1.0) — never compare it across queries.\n' +
    '- Narrow with `pathPrefix: "packages/core"` when you already know the area.\n' +
    '- `indexStatus: "no-index"` means run `/codebase-reindex` first.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'What you are trying to do or understand, in plain words.',
      },
      limit: {
        type: 'number',
        description: 'Number of files to return (default 12, max 50).',
      },
      symbolsPerFile: {
        type: 'number',
        description: 'Declarations shown per file (default 4, max 20).',
      },
      pathPrefix: {
        type: 'string',
        description: 'Restrict results to this project-relative path prefix.',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
  async execute(input, ctx, execOpts) {
    const query = typeof input.query === 'string' ? input.query.trim() : '';
    if (query.length === 0) {
      throw new ToolValidationError({
        message: 'codebase-context requires a non-empty `query`.',
        field: 'query',
      });
    }

    const signal = execOpts?.signal ?? ctx.signal;
    const projectRoot = ctx.projectRoot ?? ctx.cwd ?? process.cwd();

    try {
      signal?.throwIfAborted();
      const indexDir = codebaseIndexDirOverride(ctx);
      const vectorFiles = await semanticSeeds(projectRoot, indexDir, query);
      signal?.throwIfAborted();
      const result = await codebaseContext({
        projectRoot,
        indexDir,
        query,
        ...(vectorFiles.length > 0 ? { vectorFiles } : {}),
        limit: input.limit,
        symbolsPerFile: input.symbolsPerFile,
        pathPrefix: input.pathPrefix,
      });
      return {
        query: result.query,
        entries: result.entries,
        seedCount: result.seedCount,
        semanticSeedCount: result.semanticSeedCount,
        totalCandidates: result.totalCandidates,
        indexStatus: result.indexStatus,
        ...('stale' in result && (result as { stale?: boolean }).stale === true
          ? { stale: true }
          : {}),
      };
    } catch (err) {
      // A user cancel is not a tool failure.
      if (signal?.aborted) throw err;
      // A refresh in flight is a "try again", not a broken index — say so
      // rather than reporting the raw internal error.
      const refreshing = err instanceof Error && err.name === 'IndexRefreshInProgressError';
      return {
        query,
        entries: [],
        seedCount: 0,
        semanticSeedCount: 0,
        totalCandidates: 0,
        indexStatus: 'error',
        error: refreshing
          ? 'Codebase index is refreshing; retry once the current generation is published.'
          : toErrorMessage(err),
      };
    }
  },
};
