import * as fs from 'node:fs';
import type { MemoryCandidate, Sage, SageAuditRecord } from './types.js';

export interface SqliteAuditRow {
  event: string;
  at: string;
  trace_id: string | null;
  data: string | null;
}

export function sqliteRowToMemory(row: { data: string }): Sage {
  return JSON.parse(row.data) as Sage;
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
