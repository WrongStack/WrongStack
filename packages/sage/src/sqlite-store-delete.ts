import type { DatabaseSync } from 'node:sqlite';
import { memoryNodeId } from './sqlite-store-graph-helpers.js';
import { readSqliteSageRow, sqliteRowToMemory } from './sqlite-store-codec.js';
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
  const edgeCount = ctx
    .stmt(
      "SELECT COUNT(*) AS n FROM edges WHERE (from_node = ? OR to_node = ?) AND relation != 'related_to'",
    )
    .get(nodeId, nodeId) as { n: number };

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
    .all(id, id, id, id) as Array<{ id: string; data: string }>;
  for (const ref of refs) {
    const other = sqliteRowToMemory(ref);
    const patch: Partial<Sage> = {};
    if (other.supersedes?.includes(id)) {
      patch.supersedes = other.supersedes.filter((value) => value !== id);
    }
    if (other.contradicts?.includes(id)) {
      patch.contradicts = other.contradicts.filter((value) => value !== id);
    }
    if (other.supersededBy === id) {
      patch.supersededBy = undefined;
    }
    ctx.upsertMemory({
      ...other,
      ...patch,
      revision: other.revision + 1,
    });
  }

  ctx.upsertMemory({
    ...fresh,
    status: 'deleted',
    revision: fresh.revision + 1,
    updatedAt: ctx.nowIso(),
    ...(options.neverInject === true ? { contextPolicy: 'never' as const } : {}),
  });
  ctx.cascadeDeleteEdges(nodeId);

  ctx.audit('memory.deleted', {
    memoryId: id,
    reason,
    details: {
      removedEdges: edgeCount.n,
      force: options.force === true,
      contextPolicy: options.neverInject === true ? 'never' : 'eligible',
    },
  });
  ctx.emit('memory.deleted', {
    memoryId: id,
    reason,
    persistence: fresh.persistence ?? DEFAULT_PERSISTENCE,
    removedEdges: edgeCount.n,
    contextPolicy: options.neverInject === true ? 'never' : 'eligible',
  });
  ctx.emit('memory.updated', {
    memoryId: id,
    status: 'deleted',
    contextPolicy: options.neverInject === true ? 'never' : 'eligible',
  });
}
