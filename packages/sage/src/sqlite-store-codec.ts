import * as fs from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import type { MemoryCandidate, Sage, SageAuditRecord } from './types.js';

export interface SqliteAuditRow {
  event: string;
  at: string;
  trace_id: string | null;
  data: string | null;
}

export function sqliteRowToMemory(row: { data: string }): Sage {
  const parsed: unknown = JSON.parse(row.data);
  validateMemoryShape(parsed, row.data);
  return parsed as Sage;
}

/**
 * Minimum runtime validation for a persisted Sage record. Checks the
 * structural fields that make the record usable by the store layer.
 * Throws `CorruptMemoryError` on validation failure so callers can
 * distinguish corruption from a missing row.
 *
 * Does NOT validate every optional field — the goal is to catch
 * truncated/garbled JSON and schema-mismatch records, not to enforce
 * full type safety on every property.
 */
function validateMemoryShape(value: unknown, rawData: string): void {
  if (!value || typeof value !== 'object') {
    throw new CorruptMemoryError('Memory record is not an object', rawData);
  }
  const m = value as Record<string, unknown>;
  const required: Array<[string, string]> = [
    ['id', 'string'],
    ['text', 'string'],
    ['scope', 'string'],
    ['kind', 'string'],
    ['status', 'string'],
    ['importance', 'number'],
    ['confidence', 'number'],
    ['freshness', 'number'],
    ['createdAt', 'string'],
    ['updatedAt', 'string'],
  ];
  for (const [field, expectedType] of required) {
    const v = m[field];
    if (v === undefined || typeof v !== expectedType) {
      throw new CorruptMemoryError(
        `Memory record field "${field}" is ${v === undefined ? 'missing' : `type ${typeof v}`}, expected ${expectedType}`,
        rawData,
      );
    }
  }
}

/**
 * Error thrown when a persisted memory record fails runtime validation.
 * Carries the raw JSON so callers can log or audit the corruption detail.
 */
export class CorruptMemoryError extends Error {
  readonly rawData: string;
  constructor(message: string, rawData: string) {
    super(`Corrupt SAGE memory record: ${message}`);
    this.name = 'CorruptMemoryError';
    this.rawData = rawData;
  }
}

/**
 * Read a single memory by id from the `memories` table and parse it into
 * the typed `Sage` shape. Returns `null` when the row is missing.
 * Throws `CorruptMemoryError` when the row exists but the JSON payload
 * fails validation — so callers can distinguish corruption from absence.
 *
 * Pure read; does not mutate. The `stmt` is whatever the caller already
 * threads through (typically a `SqliteStatementCache` lookup), so the
 * helper fits the existing `Sqlite*Context` interfaces without imposing
 * a new dependency.
 */
export function readSqliteSageRow(
  stmt: (sql: string) => ReturnType<DatabaseSync['prepare']>,
  id: string,
): Sage | null {
  const row = stmt('SELECT data FROM memories WHERE id = ?').get(id) as
    | { data: string }
    | undefined;
  if (!row) return null;
  // Validation: throws CorruptMemoryError on bad shape, Error on bad JSON.
  return sqliteRowToMemory(row);
}

export function sqliteRowToCandidate(row: { data: string }): MemoryCandidate {
  return JSON.parse(row.data) as MemoryCandidate;
}

export function sqliteRowToAuditRecord(row: SqliteAuditRow): SageAuditRecord {
  let parsed: Record<string, unknown> = {};
  if (row.data) {
    try {
      const value = JSON.parse(row.data);
      if (value && typeof value === 'object') parsed = value as Record<string, unknown>;
    } catch {
      // Corrupt data column — surface the event without its detail.
    }
  }
  const record: SageAuditRecord = { schemaVersion: 1, event: row.event, at: row.at };
  if (typeof parsed['memoryId'] === 'string') record.memoryId = parsed['memoryId'];
  if (typeof parsed['source'] === 'string') record.source = parsed['source'];
  if (typeof parsed['reason'] === 'string') record.reason = parsed['reason'];
  if (row.trace_id) record.traceId = row.trace_id;
  if (parsed['details'] !== undefined) record.details = parsed['details'];
  return record;
}

export async function readLegacyJsonlRecords<T>(
  filePath: string,
  nowIso: () => string,
): Promise<T[]> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(filePath, 'utf8');
  } catch {
    // Legacy file doesn't exist or can't be read — treat as empty.
    return [];
  }
  const result: T[] = [];
  const lines = raw.split('\n');
  let corruptCount = 0;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const trimmed = lines[lineIndex]!.trim();
    if (!trimmed) continue;
    try {
      result.push(JSON.parse(trimmed) as T);
    } catch {
      corruptCount++;
    }
  }
  if (corruptCount > 0) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'sage.legacy_jsonl_corrupt_lines_skipped',
        filePath,
        corruptCount,
        recovered: result.length,
        timestamp: nowIso(),
      }),
    );
  }
  return result;
}
