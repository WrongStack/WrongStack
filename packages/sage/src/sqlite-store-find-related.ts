import type { DatabaseSync } from 'node:sqlite';

import { sqliteRowToMemory } from './sqlite-store-codec.js';
import { MEMORY_NODE_PREFIX, memoryNodeId } from './sqlite-store-graph-helpers.js';
import { collectRelatedSqliteCandidateIds } from './sqlite-store-related-candidates.js';
import { buildSessionClause } from './sqlite-store-search-helpers.js';
import { scoreMemoryRelationship } from './store-helpers.js';
import type { MemoryGraphEdge, Sage, SageStatus } from './types.js';

interface SqliteFindRelatedContext {
  stmt: (sql: string) => ReturnType<DatabaseSync['prepare']>;
  traverseGraph: (
    starts: string[],
    opts: { maxDepth: number; limit: number },
  ) => Promise<MemoryGraphEdge[]>;
  /**
   * Optional truncation callback. Fires when the BFS fetch budget was
   * saturated AND the caller requested more than the `resultCap`.
   * Mirrors the audience-retrieval emit so both retrieval surfaces
   * surface truncation consistently. The store-side `SqliteSageStore`
   * typically omits this and surfaces via the audit log instead.
   */
  onTruncated?: ((info: {
    bfsBudget: number;
    requestedLimit: number;
    scoredCount: number;
    returned: number;
  }) => void) | undefined;
}

export interface SqliteFindRelatedOptions {
  limit?: number;
  maxDepth?: number;
  includeStatuses?: SageStatus[];
  includeAudienceScoped?: boolean;
  /**
   * Session ownership filter. When set, only session-scoped memories owned
   * by this session (plus all non-session memories) are returned. When
   * unset (and `includeAllSessions` is not true), owned session-scoped
   * memories are hidden — only unowned session memories remain visible,
   * so pass `sessionId` to see your own session's records.
   */
  sessionId?: string | undefined;
  /** Admin opt-out: include all sessions' session-scoped memories. */
  includeAllSessions?: boolean | undefined;
}

export async function findRelatedSqliteSage(
  ctx: SqliteFindRelatedContext,
  memoryIds: string[],
  opts: SqliteFindRelatedOptions = {},
): Promise<Sage[]> {
  if (memoryIds.length === 0) return [];

  const statuses = opts.includeStatuses ?? ['active'];
  const session = buildSessionClause(opts);
  const seedPlaceholders = memoryIds.map(() => '?').join(',');
  const seedRows = ctx
    .stmt(`SELECT data FROM memories WHERE id IN (${seedPlaceholders})`)
    .all(...memoryIds) as Array<{ data: string }>;
  const seedIds = new Set(memoryIds);
  const seeds = seedRows.map((row) => sqliteRowToMemory(row)).filter((memory) => seedIds.has(memory.id));
  if (seeds.length === 0) return [];

  const bfsBudget = Math.max(100, (opts.limit ?? 20) * 20);
  // The result-size cap now tracks the BFS fetch budget (limit * 20,
  // floored at 100) so the user-requested `limit` is honored up to
  // what the search actually explored, instead of being silently
  // truncated to 100. The previous `Math.min(opts.limit ?? 20, 100)`
  // swallowed any caller request above 100 with no observable signal.
  const resultCap = Math.max(1, Math.min(opts.limit ?? 20, bfsBudget));
  // The graph walk runs unconditionally, before candidates are collected.
  //
  // It used to be gated on `candidateIds.length < bfsBudget`, which let the
  // weakest signal switch off the strongest one: tag co-occurrence scores 1.5
  // per shared tag (capped at 4) while graph membership scores 8, yet a tag
  // shared by enough memories pushed the candidate count past the budget and
  // skipped the traversal entirely. `graphRelatedIds` then stayed empty, so a
  // memory reachable ONLY through the graph scored 0 and was dropped by the
  // `score > 0` filter — invisible, not merely outranked. Measured on a
  // seeded store with `limit: 20` (budget 400): at 178 memories carrying the
  // seed's tag the graph neighbour was returned; at 428 it vanished. This
  // repository's live store has a tag on 972 of 2,684 active memories, well
  // past that line.
  //
  // Collecting once afterwards also removes the double tag query the old
  // shape paid whenever the gate did open (collect → traverse → collect
  // again), which offsets the unconditional traversal: ~7-15ms of walk
  // against ~22ms of re-materializing every tag match on the live store.
  const graphRelatedIds = new Set<string>();
  for (const edge of await ctx.traverseGraph(
    seeds.map((memory) => memoryNodeId(memory.id)),
    { maxDepth: opts.maxDepth ?? 3, limit: bfsBudget },
  )) {
    for (const node of [edge.from, edge.to]) {
      if (node.startsWith(MEMORY_NODE_PREFIX)) {
        graphRelatedIds.add(node.slice(MEMORY_NODE_PREFIX.length));
      }
    }
  }
  const candidateIds = collectRelatedSqliteCandidateIds(
    { stmt: (sql) => ctx.stmt(sql) },
    seeds,
    graphRelatedIds,
    statuses,
    opts,
    // Bound the one unbounded candidate source at the same budget the graph
    // walk gets, so a high-fan-out tag cannot make the fetch/parse cost scale
    // with the corpus. bfsBudget is at least 100 and 20x the caller's limit.
    bfsBudget,
  );

  if (candidateIds.length === 0) return [];

  const statusPlaceholders = statuses.map(() => '?').join(',');
  const candidates: Sage[] = [];
  const CHUNK = 400;
  for (let i = 0; i < candidateIds.length; i += CHUNK) {
    const chunk = candidateIds.slice(i, i + CHUNK);
    const idPh = chunk.map(() => '?').join(',');
    const rows = ctx
      .stmt(
        `SELECT data FROM memories
         WHERE id IN (${idPh}) AND status IN (${statusPlaceholders})${session.clause}`,
      )
      .all(...chunk, ...statuses, ...session.params) as Array<{ data: string }>;
    for (const row of rows) candidates.push(sqliteRowToMemory(row));
  }

  const scored = candidates
    .filter((memory) => !seedIds.has(memory.id))
    .filter((memory) => memory.contextPolicy !== 'never')
    .filter((memory) => opts.includeAudienceScoped !== false || !memory.audience)
    .map((memory) => ({ memory, score: scoreMemoryRelationship(memory, seeds, graphRelatedIds) }))
    .filter((item) => item.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.memory.importance - a.memory.importance ||
        b.memory.confidence - a.memory.confidence,
    );
  // Emit a truncation audit event only if the BFS fetch was saturated
  // AND the caller requested more than they got. This is the only place
  // where the previous hard-coded 100 cap could silently truncate.
  //
  // `candidateIds.length` is the *post-merge* candidate set, which is the
  // best signal we have without changing `traverseGraph`'s contract: if
  // we have at least as many candidates as the BFS budget allowed, the
  // budget was saturated (whether by seed expansion, graph expansion, or
  // both). A pure graph-traversal saturated run that produced fewer
  // candidates than `bfsBudget` is a real under-report, but fixing it
  // would require `MemoryGraphEdge[]` to expose a truncation flag.
  if (candidateIds.length >= bfsBudget && scored.length > resultCap) {
    ctx.onTruncated?.({
      bfsBudget,
      requestedLimit: opts.limit ?? 20,
      scoredCount: scored.length,
      returned: resultCap,
    });
  }
  return scored.slice(0, resultCap).map((item) => item.memory);
}
