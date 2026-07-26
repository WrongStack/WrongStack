import type { DatabaseSync } from 'node:sqlite';
import type { MemoryScope } from '@wrongstack/core/types';

import { sqliteRowToMemory } from './sqlite-store-codec.js';
import { memoryNodeId } from './sqlite-store-graph-helpers.js';
import type { Sage } from './types.js';
import { DEFAULT_PERSISTENCE, legacyToSageScope, sageToLegacyScope } from './types.js';

export interface SqliteLegacyClearContext {
  stmt: (sql: string) => ReturnType<DatabaseSync['prepare']>;
  nowIso: () => string;
  upsertMemory: (memory: Sage) => void;
  cascadeDeleteEdges: (nodeId: string) => void;
  audit: (event: string, data?: Record<string, unknown>) => void;
  emitCleared: (scope?: MemoryScope) => void;
}

export function clearLegacySqliteMemory(
  ctx: SqliteLegacyClearContext,
  scope?: MemoryScope,
): void {
  const sageScope = scope ? legacyToSageScope(scope) : undefined;
  const scopeClause = scope ? ' AND (scope = ? OR legacy_scope = ?)' : '';
  const params: string[] = scope ? [sageScope!, scope] : [];
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
