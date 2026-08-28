import type { MemoryGraphEdge, MemoryGraphRelation } from './types.js';

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
