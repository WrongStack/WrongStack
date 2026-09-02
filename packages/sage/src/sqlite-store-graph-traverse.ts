import type { DatabaseSync } from 'node:sqlite';
import { ulid } from '@wrongstack/core/utils';

import { sqliteRowToGraphEdge, type SqliteGraphEdgeRow } from './sqlite-store-graph-helpers.js';
import type { MemoryGraphEdge } from './types.js';

interface SqliteGraphTraverseContext {
  stmt: (sql: string) => ReturnType<DatabaseSync['prepare']>;
}

export function traverseSqliteGraph(
  ctx: SqliteGraphTraverseContext,
  starts: string[],
  opts?: { maxDepth?: number; limit?: number },
): MemoryGraphEdge[] {
  const maxDepth = Math.min(opts?.maxDepth ?? 2, 6);
  const limit = Math.min(opts?.limit ?? 100, 1000);

  const visitedNodes = new Set(starts);
  const visitedEdges = new Set<string>();
  const result: MemoryGraphEdge[] = [];
  let frontier = [...new Set(starts)];
  let depth = 0;

  while (frontier.length > 0 && result.length < limit && depth < maxDepth) {
    const nextFrontier: string[] = [];
    const CHUNK = 200;
    for (let i = 0; i < frontier.length; i += CHUNK) {
      const chunk = frontier.slice(i, i + CHUNK);
      const ph = chunk.map(() => '?').join(',');
      const rows = ctx
        .stmt(
          `SELECT from_node, to_node, relation, weight, created_at FROM edges
           WHERE from_node IN (${ph}) OR to_node IN (${ph})`,
        )
        .all(...chunk, ...chunk) as unknown as SqliteGraphEdgeRow[];
      const frontierSet = new Set(chunk);
      for (const r of rows) {
        if (result.length >= limit) break;
        const edgeKey = `${r.from_node}\u0000${r.to_node}\u0000${r.relation}`;
        if (visitedEdges.has(edgeKey)) continue;
        visitedEdges.add(edgeKey);
        result.push(sqliteRowToGraphEdge(ulid(), r));
        const next =
          frontierSet.has(r.from_node) && !frontierSet.has(r.to_node)
            ? r.to_node
            : frontierSet.has(r.to_node) && !frontierSet.has(r.from_node)
              ? r.from_node
              : null;
        if (next && !visitedNodes.has(next)) {
          visitedNodes.add(next);
          nextFrontier.push(next);
        }
      }
    }
    frontier = nextFrontier;
    depth += 1;
  }
  return result;
}
