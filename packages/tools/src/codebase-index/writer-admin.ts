import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { FileMeta, IndexStats, SymbolKind, SymbolLang } from './schema.js';
import { SCHEMA_VERSION } from './schema.js';

const DB_FILE = 'index.db';

type Statement = ReturnType<DatabaseSync['prepare']>;
type PrepareStatement = (sql: string) => Statement;

export function getAllIndexableWithStatement(
  stmt: PrepareStatement,
): Array<{ id: number; text: string }> {
  return (stmt('SELECT id, text FROM symbols').all() as { id: number; text: string }[]).map(
    ({ id, text }) => ({ id, text }),
  );
}

export function getMaxSymbolIdWithStatement(stmt: PrepareStatement): number {
  const rows = stmt('SELECT MAX(id) AS m FROM symbols').all() as {
    m: number | null;
  }[];
  return rows[0]?.m ?? 0;
}

export function getStatsWithStatement(stmt: PrepareStatement, indexDir: string): IndexStats {
  const lastRows = stmt("SELECT value FROM metadata WHERE key = 'last_indexed'").all() as {
    value: string;
  }[];
  const totalRows = stmt('SELECT COUNT(*) FROM symbols').all() as { 'COUNT(*)': number }[];
  const fileRows = stmt('SELECT COUNT(*) FROM files').all() as { 'COUNT(*)': number }[];
  const langRows = stmt('SELECT lang, COUNT(*) FROM symbols GROUP BY lang').all() as Array<{
    lang: string;
    'COUNT(*)': number;
  }>;
  const kindRows = stmt('SELECT kind, COUNT(*) FROM symbols GROUP BY kind').all() as Array<{
    kind: string;
    'COUNT(*)': number;
  }>;

  const byLang = {} as Record<SymbolLang, number>;
  for (const row of langRows) byLang[row.lang as SymbolLang] = Number(row['COUNT(*)']);

  const byKind = {} as Record<SymbolKind, number>;
  for (const row of kindRows) byKind[row.kind as SymbolKind] = Number(row['COUNT(*)']);

  return {
    totalSymbols: totalRows[0] ? Number(totalRows[0]['COUNT(*)']) : 0,
    totalFiles: fileRows[0] ? Number(fileRows[0]['COUNT(*)']) : 0,
    byLang,
    byKind,
    indexPath: indexDir,
    lastIndexed: lastRows.length ? Number(lastRows[0]?.value) : null,
    sizeBytes: getIndexDbSizeBytes(indexDir),
    version: SCHEMA_VERSION,
  };
}

export function getMetadataWithStatement(stmt: PrepareStatement, key: string): string | undefined {
  const rows = stmt('SELECT value FROM metadata WHERE key = ?').all(key) as {
    value: string;
  }[];
  return rows[0]?.value;
}

/**
 * P2.5: minimal index summary for search responses. Carries exactly the two
 * fields the search tool's zero-hit heuristic consumes (`totalFiles`,
 * `lastIndexed`) — NOT the full IndexStats — so a zero-hit query answers
 * "is there a persisted index at all?" without a second stats IPC round trip.
 */
export interface IndexSummary {
  totalFiles: number;
  lastIndexed: number | null;
}

export function getIndexSummaryWithStatement(stmt: PrepareStatement): IndexSummary {
  const fileRows = stmt('SELECT COUNT(*) AS n FROM files').all() as { n: number }[];
  const lastRows = stmt("SELECT value FROM metadata WHERE key = 'last_indexed'").all() as {
    value: string;
  }[];
  return {
    totalFiles: fileRows[0] ? Number(fileRows[0].n) : 0,
    lastIndexed: lastRows.length ? Number(lastRows[0]?.value) : null,
  };
}

export function getFileMetaWithStatement(stmt: PrepareStatement, file: string): FileMeta | null {
  const rows = stmt(
    'SELECT file, lang, mtime_ms, symbol_count, last_indexed, content_hash FROM files WHERE file = ?',
  ).all(file) as Array<{
    file: string;
    lang: string;
    mtime_ms: number;
    symbol_count: number;
    last_indexed: number;
    content_hash: string;
  }>;
  const r = rows[0];
  if (!r) return null;
  return {
    file: r.file,
    lang: r.lang as SymbolLang,
    mtimeMs: r.mtime_ms,
    symbolCount: r.symbol_count,
    lastIndexed: r.last_indexed,
    contentHash: r.content_hash,
  };
}

export function getAllFileMetasWithStatement(stmt: PrepareStatement): FileMeta[] {
  return (
    stmt(
      'SELECT file, lang, mtime_ms, symbol_count, last_indexed, content_hash FROM files',
    ).all() as Array<{
      file: string;
      lang: string;
      mtime_ms: number;
      symbol_count: number;
      last_indexed: number;
      content_hash: string;
    }>
  ).map((r) => ({
    file: r.file,
    lang: r.lang as SymbolLang,
    mtimeMs: r.mtime_ms,
    symbolCount: r.symbol_count,
    lastIndexed: r.last_indexed,
    contentHash: r.content_hash,
  }));
}

function getIndexDbSizeBytes(indexDir: string): number {
  try {
    return fs.statSync(path.join(indexDir, DB_FILE)).size;
  } catch {
    return 0;
  }
}
