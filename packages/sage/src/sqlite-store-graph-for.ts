import type { DatabaseSync } from 'node:sqlite';

import { normalizeProjectPath, normalizeSlashes } from './paths.js';
import { sqliteAnchorNode } from './sqlite-store-anchors.js';
import { sqliteRowToMemory } from './sqlite-store-codec.js';
import { MEMORY_NODE_PREFIX, memoryNodeId } from './sqlite-store-graph-helpers.js';
import { escapeGlobPattern } from './sqlite-store-pagination.js';
import type { MemoryGraphEdge, Sage } from './types.js';

interface SqliteGraphForContext {
  projectRoot: string;
  stmt: (sql: string) => ReturnType<DatabaseSync['prepare']>;
  searchSage: (query: string, opts: { limit: number }) => Promise<Sage[]>;
  traverseGraph: (
    starts: string[],
    opts: { maxDepth: number; limit: number },
  ) => Promise<MemoryGraphEdge[]>;
}

export async function graphSqliteSageFor(
  ctx: SqliteGraphForContext,
  query: string,
  maxDepth = 2,
  limit = 100,
): Promise<MemoryGraphEdge[]> {
  const starts = new Set<string>();
  const trimmed = query.trim();
  if (/^(mem|file|dir|symbol|command|session|tool|agent):/.test(trimmed)) {
    starts.add(normalizeSlashes(trimmed));
  } else if (/^[A-Za-z0-9_]+$/.test(trimmed)) {
    starts.add(memoryNodeId(trimmed));
  }
  try {
    const normalizedPath = normalizeProjectPath(ctx.projectRoot, query);
    starts.add(`file:${normalizedPath}`);
    starts.add(`dir:${normalizedPath}`);
    const symbolNodes = ctx
      .stmt('SELECT DISTINCT to_node FROM edges WHERE to_node GLOB ?')
      .all(`symbol:${escapeGlobPattern(normalizedPath)}#*`) as Array<{ to_node: string }>;
    for (const row of symbolNodes) starts.add(row.to_node);
  } catch {
    /* query is not a project-relative path — skip path-based starts */
  }
  for (const memory of await ctx.searchSage(query, { limit: 20 })) {
    starts.add(memoryNodeId(memory.id));
  }
  const memIds: string[] = [];
  for (const start of starts) {
    if (start.startsWith(MEMORY_NODE_PREFIX)) {
      memIds.push(start.slice(MEMORY_NODE_PREFIX.length));
    }
  }
  if (memIds.length > 0) {
    const placeholders = memIds.map(() => '?').join(',');
    const batchRows = ctx
      .stmt(`SELECT data FROM memories WHERE id IN (${placeholders})`)
      .all(...memIds) as Array<{ data: string }>;
    const memAnchorMap = batchRows.map((r) => sqliteRowToMemory(r));
    for (const memory of memAnchorMap) {
      for (const anchor of memory.anchors) {
        const node = sqliteAnchorNode(anchor);
        if (node) starts.add(node);
      }
    }
  }
  if (starts.size === 0) return [];
  return ctx.traverseGraph([...starts], { maxDepth, limit });
}
