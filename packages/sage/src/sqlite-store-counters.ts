import type { DatabaseSync } from 'node:sqlite';

export interface SqliteCounterContext {
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
  const stmt = ctx.stmt(
    `UPDATE memories SET data = json_set(data,
       '$.injectionCount', COALESCE(json_extract(data, '$.injectionCount'), 0) + 1,
       '$.lastAccessedAt', ?),
       updated_at = ?
     WHERE id = ? AND status != 'deleted' AND json_valid(data)`,
  );
  for (const id of memoryIds) stmt.run(now, now, id);
  ctx.audit('memory.injected', { details: { memoryIds, trigger, sessionId } });
}

export function recordSqliteUse(
  ctx: SqliteCounterContext,
  memoryIds: readonly string[],
  source: string,
  sessionId?: string,
): void {
  const now = ctx.nowIso();
  const stmt = ctx.stmt(
    `UPDATE memories SET data = json_set(data,
       '$.useCount', COALESCE(json_extract(data, '$.useCount'), 0) + 1,
       '$.lastUsedAt', ?,
       '$.lastAccessedAt', ?),
       updated_at = ?
     WHERE id = ? AND status != 'deleted' AND json_valid(data)`,
  );
  for (const id of memoryIds) stmt.run(now, now, now, id);
  ctx.audit('memory.used', { details: { memoryIds, source, sessionId } });
}
