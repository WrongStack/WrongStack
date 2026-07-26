import type { DatabaseSync } from 'node:sqlite';

import { sqliteRowToMemory } from './sqlite-store-codec.js';
import { MEMORY_NODE_PREFIX, memoryNodeId } from './sqlite-store-graph-helpers.js';
import { collectRelatedSqliteCandidateIds } from './sqlite-store-related-candidates.js';
import { scoreMemoryRelationship } from './store-helpers.js';
import type { MemoryGraphEdge, Sage, SageStatus } from './types.js';

export interface SqliteFindRelatedContext {
  stmt: (sql: string) => ReturnType<DatabaseSync['prepare']>;
  traverseGraph: (
    starts: string[],
    opts: { maxDepth: number; limit: number },
  ) => Promise<MemoryGraphEdge[]>;
}

export interface SqliteFindRelatedOptions {
  limit?: number;
  maxDepth?: number;
  includeStatuses?: SageStatus[];
  includeAudienceScoped?: boolean;
}

export async function findRelatedSqliteSage(
  ctx: SqliteFindRelatedContext,
  memoryIds: string[],
  opts: SqliteFindRelatedOptions = {},
): Promise<Sage[]> {
  if (memoryIds.length === 0) return [];

  const statuses = opts.includeStatuses ?? ['active'];
  const seedPlaceholders = memoryIds.map(() => '?').join(',');
  const seedRows = ctx
    .stmt(`SELECT data FROM memories WHERE id IN (${seedPlaceholders})`)
    .all(...memoryIds) as Array<{ data: string }>;
  const seedIds = new Set(memoryIds);
  const seeds = seedRows.map((row) => sqliteRowToMemory(row)).filter((memory) => seedIds.has(memory.id));
  if (seeds.length === 0) return [];

  const bfsBudget = Math.max(100, (opts.limit ?? 20) * 20);
  const graphRelatedIds = new Set<string>();
  let candidateIds = collectRelatedSqliteCandidateIds(
    { stmt: (sql) => ctx.stmt(sql) },
    seeds,
    graphRelatedIds,
    statuses,
  );

  if (candidateIds.length < bfsBudget) {
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
    if (graphRelatedIds.size > 0) {
      candidateIds = collectRelatedSqliteCandidateIds(
        { stmt: (sql) => ctx.stmt(sql) },
        seeds,
        graphRelatedIds,
        statuses,
      );
    }
  }

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
         WHERE id IN (${idPh}) AND status IN (${statusPlaceholders})`,
      )
      .all(...chunk, ...statuses) as Array<{ data: string }>;
    for (const row of rows) candidates.push(sqliteRowToMemory(row));
  }

  return candidates
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
    )
    .slice(0, Math.max(1, Math.min(opts.limit ?? 20, 100)))
    .map((item) => item.memory);
}
