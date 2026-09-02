import type { DatabaseSync } from 'node:sqlite';
import { AUDIT_LOG_MAX_ROWS, AUDIT_LOG_PRUNE_INTERVAL } from './sqlite-store-schema.js';
import { sqliteRowToAuditRecord, type SqliteAuditRow } from './sqlite-store-codec.js';
import type { SageAuditRecord } from './types.js';

interface SqliteAuditContext {
  stmt: (sql: string) => ReturnType<DatabaseSync['prepare']>;
  nowIso: () => string;
  getTraceId: () => string | undefined;
  getWritesSincePrune: () => number;
  setWritesSincePrune: (value: number) => void;
}

export function writeSqliteAudit(
  ctx: SqliteAuditContext,
  event: string,
  data?: Record<string, unknown>,
): void {
  ctx
    .stmt('INSERT INTO audit_log (event, at, trace_id, data) VALUES (?, ?, ?, ?)')
    .run(event, ctx.nowIso(), ctx.getTraceId() ?? null, data ? JSON.stringify(data) : null);
  const writes = ctx.getWritesSincePrune() + 1;
  if (writes >= AUDIT_LOG_PRUNE_INTERVAL) {
    ctx.setWritesSincePrune(0);
    pruneSqliteAuditLog(ctx);
  } else {
    ctx.setWritesSincePrune(writes);
  }
}

export function pruneSqliteAuditLog(ctx: Pick<SqliteAuditContext, 'stmt'>): void {
  ctx
    .stmt(
      `DELETE FROM audit_log WHERE id NOT IN (
         SELECT id FROM audit_log ORDER BY id DESC LIMIT ?
       )`,
    )
    .run(AUDIT_LOG_MAX_ROWS);
}

export function readSqliteAudit(
  ctx: Pick<SqliteAuditContext, 'stmt'>,
  limit = 50,
): SageAuditRecord[] {
  const rows = ctx
    .stmt('SELECT event, at, trace_id, data FROM audit_log ORDER BY id DESC LIMIT ?')
    .all(Math.max(1, Math.floor(limit))) as unknown as SqliteAuditRow[];
  return rows.map((row) => sqliteRowToAuditRecord(row));
}
