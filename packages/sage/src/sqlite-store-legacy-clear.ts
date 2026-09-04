import type { DatabaseSync } from 'node:sqlite';
import type { MemoryScope } from '@wrongstack/core/types';

import { sqliteRowToMemory } from './sqlite-store-codec.js';
import { cleanReferencingMemories, memoryNodeId } from './sqlite-store-graph-helpers.js';
import { legacyScopeFilterClause } from './store-helpers.js';
import type { Sage } from './types.js';
import { DEFAULT_PERSISTENCE, sageToLegacyScope } from './types.js';

interface SqliteLegacyClearContext {
  stmt: (sql: string) => ReturnType<DatabaseSync['prepare']>;
  nowIso: () => string;
  upsertMemory: (memory: Sage) => void;
  cascadeDeleteEdges: (nodeId: string) => void;
  audit: (event: string, data?: Record<string, unknown>) => void;
  emitCleared: (scope?: MemoryScope) => void;
}

export function clearLegacySqliteMemory(ctx: SqliteLegacyClearContext, scope?: MemoryScope): void {
  const filter = scope ? legacyScopeFilterClause(scope) : undefined;
  const scopeClause = filter ? ` AND ${filter.clause}` : '';
  const params: string[] = filter ? [...filter.params] : [];
  const rows = ctx
    .stmt(`SELECT data FROM memories WHERE status != 'deleted'${scopeClause}`)
    .all(...params) as Array<{ data: string }>;
  const skippedPermanent: string[] = [];
  const clearedIds: string[] = [];
  for (const row of rows) {
    let memory: Sage;
    try {
      memory = sqliteRowToMemory(row);
    } catch {
      continue;
    }
    if (!memory.id || !memory.createdAt || !memory.updatedAt) continue;
    const legacyScope = memory.legacyScope ?? sageToLegacyScope(memory.scope);
    if (scope && legacyScope !== scope) continue;
    if ((memory.persistence ?? DEFAULT_PERSISTENCE) === 'permanent') {
      skippedPermanent.push(memory.id);
      continue;
    }
    ctx.upsertMemory({
      ...memory,
      status: 'deleted',
      revision: memory.revision + 1,
      updatedAt: ctx.nowIso(),
    });
    cleanReferencingMemories(ctx, memory.id);
    ctx.cascadeDeleteEdges(memoryNodeId(memory.id));
    clearedIds.push(memory.id);
  }
  if (clearedIds.length > 0) {
    ctx.emitCleared(scope);
  }
  if (skippedPermanent.length > 0) {
    ctx.audit('memory.clear_skipped_permanent', {
      details: { skipped: skippedPermanent, scope: scope ?? 'all' },
    });
  }
  ctx.audit('memory.bulk_clear_completed', {
    details: {
      scope: scope ?? 'all',
      deleted: clearedIds.length,
      skippedPermanent: skippedPermanent.length,
    },
  });
}
