import type { DatabaseSync } from 'node:sqlite';
import { cleanReferencingMemories, memoryNodeId } from './sqlite-store-graph-helpers.js';
import { matchesLegacyForget } from './sqlite-store-legacy.js';
import { sqliteRowToMemory } from './sqlite-store-codec.js';
import { legacyScopeFilterClause } from './store-helpers.js';
import type { MemoryScope } from '@wrongstack/core/types';
import type { Sage } from './types.js';
import { DEFAULT_PERSISTENCE, sageToLegacyScope } from './types.js';

interface SqliteLegacyForgetContext {
  stmt: (sql: string) => ReturnType<DatabaseSync['prepare']>;
  nowIso: () => string;
  upsertMemory: (memory: Sage) => void;
  cascadeDeleteEdges: (nodeId: string) => void;
  audit: (event: string, data?: Record<string, unknown>) => void;
  emitForgotten: (scope: MemoryScope, query: string, removed: number) => void;
}

export function forgetLegacySqliteMemory(
  ctx: SqliteLegacyForgetContext,
  query: string,
  scope: MemoryScope,
): number {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return 0;
  const filter = legacyScopeFilterClause(scope);
  const rows = ctx
    .stmt(`SELECT data FROM memories WHERE status != ? AND ${filter.clause}`)
    .all('deleted', ...filter.params) as Array<{ data: string }>;
  let removed = 0;
  const skippedPermanent: string[] = [];
  for (const row of rows) {
    let memory: Sage;
    try {
      memory = sqliteRowToMemory(row);
    } catch {
      continue;
    }
    if ((memory.legacyScope ?? sageToLegacyScope(memory.scope)) !== scope) continue;
    if (!matchesLegacyForget(memory, normalized)) continue;
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
    removed++;
  }
  if (removed > 0) {
    ctx.audit('memory.deleted', { reason: query, details: { removed, scope } });
    ctx.emitForgotten(scope, query, removed);
  }
  if (skippedPermanent.length > 0) {
    ctx.audit('memory.forget_skipped_permanent', {
      reason: query,
      details: { skipped: skippedPermanent, scope },
    });
  }
  return removed;
}
