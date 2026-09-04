import type { DatabaseSync } from 'node:sqlite';

interface SqliteCounterContext {
  stmt: (sql: string) => ReturnType<DatabaseSync['prepare']>;
  nowIso: () => string;
  audit: (event: string, data?: Record<string, unknown>) => void;
}

export function recordSqliteInjection(
  ctx: SqliteCounterContext,
  memoryIds: readonly string[],
  trigger: string,
  sessionId?: string,
): void {
  const now = ctx.nowIso();
  // Deliberately does NOT touch `updated_at`: that column is the content
  // recency clock (pagination ordering, retention aging, empty-query
  // ranking). Bumping it here made recency reflect injection activity and
  // silently defeated the hygiene `injected_never_used` check, which ages
  // by `lastAccessedAt ?? updatedAt`. Usage telemetry lives in the JSON
  // data (injectionCount/lastAccessedAt), not the ordering clock.
  const stmt = ctx.stmt(
    `UPDATE memories SET data = json_set(data,
       '$.injectionCount', COALESCE(json_extract(data, '$.injectionCount'), 0) + 1,
       '$.lastAccessedAt', ?)
     WHERE id = ? AND status != 'deleted' AND json_valid(data)`,
  );
  const uniqueIds = [...new Set(memoryIds)];
  for (const id of uniqueIds) stmt.run(now, id);
  ctx.audit('memory.injected', { details: { memoryIds: uniqueIds, trigger, sessionId } });
}

export function recordSqliteUse(
  ctx: SqliteCounterContext,
  memoryIds: readonly string[],
  source: string,
  sessionId?: string,
): void {
  const now = ctx.nowIso();
  // Same as recordSqliteInjection: `updated_at` is the content recency
  // clock and must not be advanced by feedback bookkeeping.
  const stmt = ctx.stmt(
    `UPDATE memories SET data = json_set(data,
       '$.useCount', COALESCE(json_extract(data, '$.useCount'), 0) + 1,
       '$.lastUsedAt', ?,
       '$.lastAccessedAt', ?)
     WHERE id = ? AND status != 'deleted' AND json_valid(data)`,
  );
  const uniqueIds = [...new Set(memoryIds)];
  for (const id of uniqueIds) stmt.run(now, now, id);
  ctx.audit('memory.used', { details: { memoryIds: uniqueIds, source, sessionId } });
}
