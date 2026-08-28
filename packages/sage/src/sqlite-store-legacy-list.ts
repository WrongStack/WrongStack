import type { DatabaseSync } from 'node:sqlite';
import type { MemoryEntry, MemoryScope } from '@wrongstack/core/types';

import { sqliteRowToMemory } from './sqlite-store-codec.js';
import { legacyScopeFilterClause } from './store-helpers.js';
import type { Sage } from './types.js';
import { sageToLegacyScope, toLegacyEntry } from './types.js';

interface SqliteLegacyListContext {
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
  // Byte comparison (locale-safe): ISO-8601 timestamps sort lexicographically;
  // `localeCompare` can reorder them across locales (see shared/pagination.ts).
  parsed.sort(
    (a, b) =>
      b.createdAt > a.createdAt
        ? 1
        : b.createdAt < a.createdAt
          ? -1
          : b.id > a.id
            ? 1
            : b.id < a.id
              ? -1
              : 0,
  );
  const entries = parsed.map(({ memory }) => toLegacyEntry(memory));
  return limit === undefined ? entries : entries.slice(0, Math.max(0, limit));
}
