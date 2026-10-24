import type { Tool } from '@wrongstack/contracts/types';
import type { SageServiceLike } from '../service-contract.js';
import type {
  FindMemoriesForFileResponse,
  GatherBatchResult,
  ListSagePageOptions,
  MemoryGraphEdge,
  Sage,
} from '../types.js';
import { callerSessionId } from './memory-tool-session.js';
import { numberSchema, objectSchema, STATUS_VALUES, stringSchema } from './tool-schema-helpers.js';

/** Resource limit: at most this many memory IDs are individually queried for graph relations during batch gather. */
const BATCH_GRAPH_SCAN_LIMIT = 10;

/**
 * Rich file-drawer query: returns three buckets (`primaryMatches`,
 * `symbolMatches`, `relatedMatches`) with `matchedVia`, `matchStrength`,
 * `supersededByActiveId`, and `pendingReview` metadata so the file-editor
 * UI can render "why this matched" + give the user recovery / review actions.
 *
 * Side-effect-free: opening a file in the editor must never mutate the memory
 * store. Cursor-aware via `lineStart`/`lineEnd` — when both are provided,
 * symbol anchors overlapping that range get a strength boost (0.95) so the
 * user sees the most relevant notes pinned when their caret lands on a
 * function/class.
 */
export function memoryForFileTool(memory: SageServiceLike): Tool<
  {
    path: string;
    /** Optional cursor line — symbol anchors overlapping get a strength boost. */
    lineStart?: number;
    lineEnd?: number;
    /** Per-bucket cap. Default 50. */
    limit?: number;
    /** Default true. Include superseded memories (with `supersededByActiveId`). */
    showSuperseded?: boolean;
    /**
     * Default false. Set true (typically via a "Show recoverable" UI toggle)
     * to surface `status='deleted'` memories for one-click recovery.
     */
    showDeleted?: boolean;
  },
  FindMemoriesForFileResponse
> {
  return {
    name: 'memory_for_file',
    category: 'Inspect',
    description:
      'Retrieve memories attached to a file, grouped by how they match. ' +
      'Supports a cursor line range so symbol-anchored memories under the caret surface first.',
    usageHint:
      'Use when opening a file in the editor and you want to surface every memory ' +
      'that is attached, anchored, or mentions the file. Pass `lineStart` / `lineEnd` ' +
      'to pin symbol-anchored memories overlapping the cursor.\n' +
      '- `primaryMatches`: scope_file or file/directory anchor (strongest).\n' +
      '- `symbolMatches`: scope_symbol or symbol anchor (cursor-boosted).\n' +
      '- `relatedMatches`: text mentions (weakest — shown under "Mentioned in").\n' +
      'Set `showDeleted: true` after a Show-recoverable toggle to include deleted records.',
    inputSchema: objectSchema(
      {
        path: stringSchema('Project-relative file path.'),
        lineStart: {
          type: 'integer',
          minimum: 1,
          description:
            'Optional — caret line (1-indexed). When both `lineStart` and `lineEnd` are set, symbol anchors overlapping this range get a strength boost.',
        },
        lineEnd: {
          type: 'integer',
          minimum: 1,
          description: 'Optional — last caret line. Pair with `lineStart`.',
        },
        limit: { ...numberSchema(1, 200), description: 'Per-bucket cap. Default 50.' },
        showSuperseded: {
          type: 'boolean',
          description: 'Default true. Set false to hide superseded memories (use for compact UI).',
        },
        showDeleted: {
          type: 'boolean',
          description:
            'Default false. Set true (typically via a "Show recoverable" UI toggle) to surface deleted memories for recovery.',
        },
      },
      ['path'],
    ),
    permission: 'auto',
    mutating: false,
    riskTier: 'safe',
    capabilities: ['memory.read'],
    icon: 'search',
    async execute(input, ctx, opts) {
      const signal = opts?.signal ?? ctx?.signal;
      signal?.throwIfAborted();
      return memory.findMemoriesForFile(input.path, {
        sessionId: callerSessionId(ctx),
        ...(input.lineStart !== undefined ? { lineStart: input.lineStart } : {}),
        ...(input.lineEnd !== undefined ? { lineEnd: input.lineEnd } : {}),
        limit: input.limit ?? 50,
        includeSuperseded: input.showSuperseded !== false,
        includeDeleted: input.showDeleted === true,
      });
    },
  };
}

export function memoryForPathTool(
  memory: SageServiceLike,
): Tool<{ path: string; limit?: number }, Sage[]> {
  return {
    name: 'memory_for_path',
    category: 'Inspect',
    description: 'Retrieve project knowledge for a path and its ancestor directories.',
    inputSchema: objectSchema(
      {
        path: stringSchema('Project-relative file or directory path.'),
        limit: numberSchema(1, 50),
      },
      ['path'],
    ),
    permission: 'auto',
    mutating: false,
    riskTier: 'safe',
    capabilities: ['memory.read'],
    icon: 'search',
    async execute(input, ctx, opts) {
      const signal = opts?.signal ?? ctx?.signal;
      signal?.throwIfAborted();
      return memory.retrieveForPath({
        path: input.path,
        limit: input.limit ?? 20,
        includeAncestors: true,
        sessionId: callerSessionId(ctx),
      });
    },
  };
}

export function memorySearchTool(
  memory: SageServiceLike,
): Tool<{ query: string; limit?: number; include_stale?: boolean }, Sage[]> {
  return {
    name: 'memory_search',
    category: 'Inspect',
    description: 'Search structured project memory using lexical, tag, path, and anchor signals.',
    inputSchema: objectSchema(
      {
        query: stringSchema('Search text, symbol, tag, command, or path.'),
        limit: numberSchema(1, 100),
        include_stale: { type: 'boolean' },
      },
      ['query'],
    ),
    permission: 'auto',
    mutating: false,
    riskTier: 'safe',
    capabilities: ['memory.read'],
    icon: 'search',
    async execute(input, ctx, opts) {
      const signal = opts?.signal ?? ctx?.signal;
      signal?.throwIfAborted();
      return memory.searchSage(input.query, {
        limit: input.limit ?? 20,
        includeStatuses: input.include_stale ? ['active', 'stale'] : ['active'],
        // Without this the tool could never read back a session-scoped memory
        // — not even one written moments earlier by this same session.
        sessionId: callerSessionId(ctx),
      });
    },
  };
}

/**
 * Rich-variant tool: returns the same hits as `memory_search` but with a
 * per-channel breakdown — which channels matched, the lexical / vector
 * scores, the RRF final score, and a `source` attribution. Use this
 * when the agent needs to answer "why was this memory returned?" and
 * to choose between competing channels (e.g. trust the lexical match
 * for an exact symbol, or trust the semantic match for a paraphrase).
 *
 * Falls back to plain `memory_search` results (with `vectorScore: null`
 * and `source: 'lexical'`) when the underlying port doesn't expose
 * `searchSageWithBreakdown` — keeps the tool usable on remote IPC
 * ports that don't ship the rich variant.
 */
export function memorySearchExplainTool(memory: SageServiceLike): Tool<
  { query: string; limit?: number; include_stale?: boolean },
  Array<{
    memory: Sage;
    vectorScore: number | null;
    lexicalScore: number | null;
    finalScore: number;
    source: 'lexical' | 'vector' | 'both';
  }>
> {
  return {
    name: 'memory_search_explain',
    category: 'Inspect',
    description:
      'Like `memory_search` but each result carries a per-channel score ' +
      'breakdown — lexical score, vector score, RRF final score, and a ' +
      '`source` attribution (`lexical` | `vector` | `both`). Use when the ' +
      'agent needs to weigh channels (e.g. trust a paraphrased semantic ' +
      'hit vs an exact lexical hit) or to surface WHY a result is in ' +
      'the list. Falls back to lexical-only hits when the underlying port ' +
      'does not expose the rich variant.',
    inputSchema: objectSchema(
      {
        query: stringSchema('Search text, symbol, tag, command, or path.'),
        limit: numberSchema(1, 100),
        include_stale: { type: 'boolean' },
      },
      ['query'],
    ),
    permission: 'auto',
    mutating: false,
    riskTier: 'safe',
    capabilities: ['memory.read'],
    icon: 'search',
    async execute(input, ctx, opts) {
      const signal = opts?.signal ?? ctx?.signal;
      signal?.throwIfAborted();
      const sessionId = callerSessionId(ctx);
      const includeStatuses: Sage['status'][] = input.include_stale
        ? ['active', 'stale']
        : ['active'];
      // Prefer the rich variant when the port exposes it.
      if (memory.searchSageWithBreakdown) {
        const hits = await memory.searchSageWithBreakdown(input.query, {
          limit: input.limit ?? 20,
          includeStatuses,
          sessionId,
        });
        return hits.map((h) => ({
          memory: h.memory,
          vectorScore: h.vectorScore,
          lexicalScore: h.lexicalScore,
          finalScore: h.finalScore,
          source: h.source,
        }));
      }
      // Fallback: synthesize a lexical-only breakdown so consumers can
      // branch on `source` and `vectorScore` uniformly. The position
      // score is the same `1 - index / (n - 1)` heuristic the wrapper
      // uses, so the per-result scores stay consistent.
      const rows = await memory.searchSage(input.query, {
        limit: input.limit ?? 20,
        includeStatuses: includeStatuses as Sage['status'][],
        sessionId,
      });
      const total = rows.length;
      return rows.map((memory, index) => ({
        memory,
        vectorScore: null,
        lexicalScore: total <= 1 ? 1 : 1 - index / (total - 1),
        finalScore: total <= 1 ? 1 : 1 - index / (total - 1),
        source: 'lexical' as const,
      }));
    },
  };
}

export function memoryGraphTool(
  memory: SageServiceLike,
): Tool<{ query: string; depth?: number; limit?: number }, MemoryGraphEdge[]> {
  return {
    name: 'memory_graph',
    category: 'Inspect',
    description: 'Traverse relationships between memories, files, symbols, commands, and sessions.',
    inputSchema: objectSchema(
      {
        query: stringSchema('A memory id, graph node, path, symbol, or search query.'),
        depth: numberSchema(1, 6),
        limit: numberSchema(1, 500),
      },
      ['query'],
    ),
    permission: 'auto',
    mutating: false,
    riskTier: 'safe',
    capabilities: ['memory.read'],
    icon: 'tree',
    async execute(input, ctx, opts) {
      const signal = opts?.signal ?? ctx?.signal;
      signal?.throwIfAborted();
      return memory.graphFor(input.query, input.depth ?? 2, input.limit ?? 100);
    },
  };
}

export function memoryGatherBatchTool(memory: SageServiceLike): Tool<
  {
    statuses?: Sage['status'][] | undefined;
    kind?: string | undefined;
    query?: string | undefined;
    limit?: number | undefined;
    cursor?: string | undefined;
    /** Include graph edges among gathered memories. Default true. */
    includeRelations?: boolean | undefined;
  },
  GatherBatchResult
> {
  return {
    name: 'memory_gather_batch',
    category: 'Session',
    description:
      'Gather a bounded batch of memories with optional graph relations. Use this for bulk memory review and cleanup workflows — enumerates active memories by status, kind, or text substring, and optionally includes their graph edges for collective evaluation.',
    inputSchema: objectSchema({
      statuses: {
        type: 'array',
        items: { type: 'string', enum: STATUS_VALUES },
        description: 'Statuses to include. Default: all except deleted.',
      },
      kind: stringSchema('Optional kind filter (e.g. "fact").'),
      query: stringSchema('Case-insensitive substring match against memory text.'),
      limit: numberSchema(1, 500),
      cursor: stringSchema("Opaque cursor from a previous page's `nextCursor`."),
      includeRelations: {
        type: 'boolean',
        description: 'Include graph edges among gathered memories. Default true.',
      },
    }),
    permission: 'auto',
    mutating: false,
    riskTier: 'safe',
    capabilities: ['memory.read'],
    icon: 'search',
    async execute(input, ctx, opts) {
      const signal = opts?.signal ?? ctx?.signal;
      signal?.throwIfAborted();
      const pageOpts: ListSagePageOptions = {
        statuses: input.statuses,
        kind: input.kind,
        query: input.query,
        limit: input.limit,
        cursor: input.cursor,
        // Bulk enumeration is the widest read in the tool surface — 500 rows a
        // page, cursor-paged over everything. It gets the same session filter
        // as every other read rather than an exemption for being a bulk API.
        sessionId: callerSessionId(ctx),
      };
      const page = await memory.listSagePage(pageOpts);
      // Optionally gather graph relations for the first N memories
      const relations: MemoryGraphEdge[] = [];
      let scannedCount = 0;
      let graphFailures = 0;
      let firstGraphError: unknown;
      if (input.includeRelations !== false && page.memories.length > 0) {
        const seen = new Set<string>();
        const idsToScan = page.memories.slice(0, BATCH_GRAPH_SCAN_LIMIT);
        for (const mem of idsToScan) {
          signal?.throwIfAborted();
          scannedCount++;
          try {
            const edges = await memory.graphFor(mem.id, 1, 100);
            for (const edge of edges) {
              if (!seen.has(edge.id)) {
                seen.add(edge.id);
                relations.push(edge);
              }
            }
          } catch (err) {
            // Best-effort: one memory's graph failure does not fail the batch;
            // rethrow abort so the caller can cancel promptly.
            if (signal?.aborted) throw err;
            graphFailures++;
            firstGraphError ??= err;
          }
        }
        // Every lookup failing is a graph outage, not "no relations".
        if (graphFailures > 0 && graphFailures === scannedCount) {
          const detail =
            firstGraphError instanceof Error ? firstGraphError.message : String(firstGraphError);
          throw new Error(
            `memory_gather_batch: relation lookup failed for all ${scannedCount} memories (${detail}). Retry with includeRelations: false to skip relations.`,
            { cause: firstGraphError },
          );
        }
      }
      return {
        memories: page.memories,
        relations,
        relationsScannedAt: scannedCount,
        nextCursor: page.nextCursor,
        total: page.total,
        statusCounts: page.statusCounts,
      };
    },
  };
}
