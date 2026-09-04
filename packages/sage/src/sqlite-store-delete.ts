import type { DatabaseSync } from 'node:sqlite';
import { cleanReferencingMemories, memoryNodeId } from './sqlite-store-graph-helpers.js';
import { readSqliteSageRow } from './sqlite-store-codec.js';
import type { Sage } from './types.js';
import { DEFAULT_PERSISTENCE } from './types.js';

interface SqliteDeleteContext {
  stmt: (sql: string) => ReturnType<DatabaseSync['prepare']>;
  nowIso: () => string;
  upsertMemory: (memory: Sage) => void;
  cascadeDeleteEdges: (nodeId: string) => void;
  audit: (event: string, data?: Record<string, unknown>) => void;
  emit: (event: 'memory.deleted' | 'memory.updated', payload: Record<string, unknown>) => void;
}

export function deleteSqliteSage(
  ctx: SqliteDeleteContext,
  id: string,
  reason: string,
  options: { force?: boolean; neverInject?: boolean } = {},
): void {
  const fresh = readSqliteSageRow(ctx.stmt, id);
  if (!fresh) throw new Error(`SAGE "${id}" not found.`);
  if (fresh.status === 'deleted') return;

  if (!options.force) {
    if (fresh.persistence === 'permanent') {
      throw new Error(
        `SAGE "${id}" is marked 'permanent' and cannot be deleted. ` +
          `Pass { force: true } to override; the override will be recorded in the audit log.`,
      );
    }
    throw new Error(
      `SAGE "${id}" cannot be deleted without explicit authorization. ` +
        `Pass { force: true } to the memory_delete tool, or resolve a review candidate ` +
        `via memory_candidates({ action: 'resolve', decision: 'delete' }). ` +
        `The force flag is recorded in the audit log.`,
    );
  }

  const nodeId = memoryNodeId(id);

  cleanReferencingMemories(ctx, id);

  ctx.upsertMemory({
    ...fresh,
    status: 'deleted',
    revision: fresh.revision + 1,
    updatedAt: ctx.nowIso(),
    ...(options.neverInject === true ? { contextPolicy: 'never' as const } : {}),
  });
  const removedEdges = ctx
    .stmt(
      "SELECT COUNT(*) AS n FROM edges WHERE (from_node = ? OR to_node = ?) AND relation != 'related_to'",
    )
    .get(nodeId, nodeId) as { n: number };
  ctx.cascadeDeleteEdges(nodeId);

  ctx.audit('memory.deleted', {
    memoryId: id,
    reason,
    details: {
      removedEdges: removedEdges.n,
      force: options.force === true,
      contextPolicy: options.neverInject === true ? 'never' : 'eligible',
    },
  });
  ctx.emit('memory.deleted', {
    memoryId: id,
    reason,
    persistence: fresh.persistence ?? DEFAULT_PERSISTENCE,
    removedEdges: removedEdges.n,
    contextPolicy: options.neverInject === true ? 'never' : 'eligible',
  });
  ctx.emit('memory.updated', {
    memoryId: id,
    status: 'deleted',
    contextPolicy: options.neverInject === true ? 'never' : 'eligible',
  });
}
