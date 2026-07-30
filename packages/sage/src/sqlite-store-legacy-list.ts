import type { DatabaseSync } from 'node:sqlite';
import type { MemoryEntry, MemoryScope } from '@wrongstack/core/types';

import { sqliteRowToMemory } from './sqlite-store-codec.js';
import { legacyScopeFilterClause } from './store-helpers.js';
import type { Sage } from './types.js';
import { sageToLegacyScope, toLegacyEntry } from './types.js';

export interface SqliteLegacyListContext {
  stmt: (sql: string) => ReturnType<DatabaseSync['prepare']>;
}

export function listLegacySqliteMemory(
  ctx: SqliteLegacyListContext,
  scope: MemoryScope,
  limit?: number,
): MemoryEntry[] {
  const filter = legacyScopeFilterClause(scope);
  const rows = ctx
    .stmt(
      `SELECT data, created_at FROM memories WHERE status = 'active' AND ${filter.clause} ORDER BY created_at DESC, id DESC`,
    )
    .all(...filter.params) as Array<{ data: string; created_at: string }>;
  const parsed = rows
    .map((row) => {
      try {
        const memory = sqliteRowToMemory(row);
        return { memory, id: memory.id ?? '', createdAt: row.created_at ?? memory.createdAt ?? '' };
      } catch {
        return null;
      }
    })
    .filter((item): item is { memory: Sage; id: string; createdAt: string } => item !== null)
    .filter(({ memory }) => (memory.legacyScope ?? sageToLegacyScope(memory.scope)) === scope);
  parsed.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  const entries = parsed.map(({ memory }) => toLegacyEntry(memory));
  return limit === undefined ? entries : entries.slice(0, Math.max(0, limit));
}
