import type { DatabaseSync } from 'node:sqlite';
import { sqliteRowToMemory } from './sqlite-store-codec.js';
import type { MemoryGraphEdge, MemoryGraphRelation, Sage } from './types.js';

/** Prefix used for graph node ids referencing memories. */
export const MEMORY_NODE_PREFIX = 'mem:';

/** SQL GLOB matching every graph node id owned by a memory. */
export const MEMORY_NODE_GLOB = `${MEMORY_NODE_PREFIX}*`;

/** Length of the graph node id prefix (e.g. "mem:" = 4). */
export const MEMORY_NODE_PREFIX_LEN = MEMORY_NODE_PREFIX.length;

/** Build the canonical graph node id for a memory. */
export function memoryNodeId(memoryId: string): string {
  return `${MEMORY_NODE_PREFIX}${memoryId}`;
}

/**
 * Reconstruct the human-readable structural evidence (`<anchorType>:<path>`)
 * for an `about_*` anchor edge from its relation and target node.
 */
function edgeEvidence(relation: string, toNode: string): { evidence: string[] } | undefined {
  const match = /^about_(\w+)$/.exec(relation);
  if (!match) return undefined;
  const anchorType = match[1];
  const anchorPath = toNode.replace(/^(file|dir|symbol):/, '');
  return { evidence: [`${anchorType}:${anchorPath}`] };
}

export interface SqliteGraphEdgeRow {
  from_node: string;
  to_node: string;
  relation: MemoryGraphRelation;
  weight: number;
  created_at: string;
}

export function sqliteRowToGraphEdge(id: string, row: SqliteGraphEdgeRow): MemoryGraphEdge {
  return {
    id,
    from: row.from_node,
    to: row.to_node,
    relation: row.relation,
    weight: row.weight,
    createdAt: row.created_at,
    schemaVersion: 1,
    ...(edgeEvidence(row.relation, row.to_node) ?? {}),
  };
}

export interface SqliteReferenceCleanupContext {
  stmt: (sql: string) => ReturnType<DatabaseSync['prepare']>;
  nowIso: () => string;
  upsertMemory: (memory: Sage) => void;
}

/**
 * Remove references to a deleted memory (`targetId`) from other active/stale memories'
 * `supersedes`, `contradicts`, and `supersededBy` fields.
 */
export function cleanReferencingMemories(
  ctx: SqliteReferenceCleanupContext,
  targetId: string,
): void {
  const refs = ctx
    .stmt(
      `SELECT id, data FROM memories
       WHERE id != ?
         AND status != 'deleted'
         AND (
           json_extract(data, '$.supersededBy') = ?
           OR EXISTS (
             SELECT 1 FROM json_each(COALESCE(json_extract(data, '$.supersedes'), '[]'))
             WHERE value = ?
           )
           OR EXISTS (
             SELECT 1 FROM json_each(COALESCE(json_extract(data, '$.contradicts'), '[]'))
             WHERE value = ?
           )
         )`,
    )
    .all(targetId, targetId, targetId, targetId) as Array<{ id: string; data: string }>;

  for (const ref of refs) {
    const other = sqliteRowToMemory(ref);
    const patch: Partial<Sage> = {};
    if (other.supersedes?.includes(targetId)) {
      patch.supersedes = other.supersedes.filter((value) => value !== targetId);
    }
    if (other.contradicts?.includes(targetId)) {
      patch.contradicts = other.contradicts.filter((value) => value !== targetId);
    }
    if (other.supersededBy === targetId) {
      patch.supersededBy = undefined;
    }
    ctx.upsertMemory({
      ...other,
      ...patch,
      revision: other.revision + 1,
      updatedAt: ctx.nowIso(),
    });
  }
}
