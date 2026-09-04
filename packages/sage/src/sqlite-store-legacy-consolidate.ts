import type { DatabaseSync } from 'node:sqlite';
import type { MemoryScope } from '@wrongstack/core/types';

import { sqliteRowToMemory } from './sqlite-store-codec.js';
import { legacyScopeFilterClause, normalizeTextKey } from './store-helpers.js';
import type { Sage } from './types.js';
import { DEFAULT_PERSISTENCE, sageToLegacyScope } from './types.js';

interface SqliteLegacyConsolidateContext {
  stmt: (sql: string) => ReturnType<DatabaseSync['prepare']>;
  nowIso: () => string;
  upsertMemory: (memory: Sage) => void;
  syncAnchorEdges: (memory: Sage) => void;
  audit: (event: string, data?: Record<string, unknown>) => void;
  emitConsolidated: (scope: MemoryScope, removed: number) => void;
}

export function consolidateLegacySqliteMemory(
  ctx: SqliteLegacyConsolidateContext,
  scope: MemoryScope,
): void {
  // Push scope filter into SQL using the indexed `scope` and `legacy_scope`
  // columns so the consolidator does not incur O(N) full-table JSON parses.
  const filter = legacyScopeFilterClause(scope);
  const rows = ctx
    .stmt(`SELECT data FROM memories WHERE status IN ('active','stale') AND ${filter.clause}`)
    .all(...filter.params) as Array<{ data: string }>;
  const groups = new Map<string, Sage[]>();
  for (const row of rows) {
    let memory: Sage;
    try {
      memory = sqliteRowToMemory(row);
    } catch {
      continue;
    }
    if ((memory.legacyScope ?? sageToLegacyScope(memory.scope)) !== scope) continue;
    const key = normalizeTextKey(memory.text);
    const group = groups.get(key);
    if (group) group.push(memory);
    else groups.set(key, [memory]);
  }

  let removed = 0;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const mutable = group.filter((m) => (m.persistence ?? DEFAULT_PERSISTENCE) !== 'permanent');
    if (mutable.length < 2) continue;
    const [keeper, ...duplicates] = [...mutable].sort(
      (a, b) => b.importance - a.importance || b.confidence - a.confidence,
    );
    const selectedKeeper = keeper!;
    const updatedKeeper: Sage = {
      ...selectedKeeper,
      tags: [...new Set(mutable.flatMap((memory) => memory.tags))],
      anchors: [
        ...new Map(
          mutable
            .flatMap((m) => m.anchors)
            .map((a) => [
              `${a.type}\u0000${a.path ?? ''}\u0000${a.symbol ?? ''}\u0000${a.command ?? ''}\u0000${a.role ?? ''}`,
              a,
            ]),
        ).values(),
      ],
      sources: [
        ...new Map(
          mutable.flatMap((m) => m.sources).map((s) => [JSON.stringify(s), s]),
        ).values(),
      ],
      supersedes: [
        ...new Set([
          ...(selectedKeeper.supersedes ?? []),
          ...duplicates.map((memory) => memory.id),
        ]),
      ],
      revision: selectedKeeper.revision + 1,
      updatedAt: ctx.nowIso(),
    };
    ctx.upsertMemory(updatedKeeper);
    ctx.syncAnchorEdges(updatedKeeper);
    for (const duplicate of duplicates) {
      const supersededDuplicate: Sage = {
        ...duplicate,
        status: 'superseded',
        supersededBy: selectedKeeper.id,
        revision: duplicate.revision + 1,
        updatedAt: ctx.nowIso(),
      };
      ctx.upsertMemory(supersededDuplicate);
      ctx.syncAnchorEdges(supersededDuplicate);
      removed++;
    }
  }
  if (removed > 0) ctx.emitConsolidated(scope, removed);
  ctx.audit('memory.consolidation_completed', { details: { scope, removed } });
}
