import type { DatabaseSync } from 'node:sqlite';
import type { Ref } from './schema.js';
import { ladderChunkSizes } from './writer-helpers.js';

type Statement = ReturnType<DatabaseSync['prepare']>;
type PrepareStatement = (sql: string) => Statement;

export interface BulkSymbolRow {
  id: number;
  lang: string;
  kind: string;
  name: string;
  file: string;
  line: number;
  col: number;
  signature: string;
  docComment: string;
  scope: string;
}

const ROW_PLACEHOLDERS_CACHE = new Map<string, string>();

function getRowPlaceholders(rowTemplate: string, count: number): string {
  const key = `${rowTemplate}\u0000${count}`;
  let result = ROW_PLACEHOLDERS_CACHE.get(key);
  if (result === undefined) {
    result = Array.from({ length: count }, () => rowTemplate).join(', ');
    ROW_PLACEHOLDERS_CACHE.set(key, result);
  }
  return result;
}

export function bulkInsertSymbolsWithStatement(
  stmt: PrepareStatement,
  maxSqlVars: number,
  rows: BulkSymbolRow[],
): void {
  if (rows.length === 0) return;
  // P4.12: ladder chunking (powers of two) keeps distinct SQL strings ≤
  // log2(max)+1 so the statement cache stabilizes. Read via cursor — never
  // mutate the caller's array.
  const ladder = ladderChunkSizes(rows.length, Math.max(1, Math.floor(maxSqlVars / 12)));
  let cursor = 0;
  for (const take of ladder) {
    const chunk = rows.slice(cursor, cursor + take);
    cursor += take;
    const placeholders = getRowPlaceholders(
      '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      chunk.length,
    );
    const insert = stmt(
      `INSERT INTO symbols(id, lang, kind, name, file, line, col, signature, doc_comment, scope)
       VALUES ${placeholders}`,
    );
    const binds: (string | number)[] = [];
    for (const r of chunk) {
      binds.push(
        r.id,
        r.lang,
        r.kind,
        r.name,
        r.file,
        r.line,
        r.col,
        r.signature,
        r.docComment,
        r.scope,
      );
    }
    insert.run(...binds);
  }
}

export function bulkInsertFtsWithStatement(
  stmt: PrepareStatement,
  maxSqlVars: number,
  ftsAvailable: boolean,
  rows: Array<{ id: number; text: string }>,
): void {
  if (!ftsAvailable || rows.length === 0) return;
  const ladder = ladderChunkSizes(rows.length, Math.max(1, Math.floor(maxSqlVars / 2)));
  let cursor = 0;
  for (const take of ladder) {
    const chunk = rows.slice(cursor, cursor + take);
    cursor += take;
    const placeholders = getRowPlaceholders('(?, ?)', chunk.length);
    const insert = stmt(`INSERT INTO symbols_fts(rowid, text) VALUES ${placeholders}`);
    const binds: (string | number)[] = [];
    for (const r of chunk) binds.push(r.id, r.text);
    insert.run(...binds);
  }
}

export interface BulkVectorRow {
  id: number;
  vector: Uint8Array;
}

export function bulkInsertVectorsWithStatement(
  stmt: PrepareStatement,
  maxSqlVars: number,
  rows: BulkVectorRow[],
): void {
  if (rows.length === 0) return;
  const ladder = ladderChunkSizes(rows.length, Math.max(1, Math.floor(maxSqlVars / 2)));
  let cursor = 0;
  for (const take of ladder) {
    const chunk = rows.slice(cursor, cursor + take);
    cursor += take;
    const placeholders = getRowPlaceholders('(?, ?)', chunk.length);
    const insert = stmt(`INSERT INTO symbol_vectors(symbol_id, vector) VALUES ${placeholders}`);
    const binds: (number | Uint8Array)[] = [];
    for (const r of chunk) binds.push(r.id, r.vector);
    insert.run(...binds);
  }
}

export function bulkInsertRefsWithStatement(
  stmt: PrepareStatement,
  maxSqlVars: number,
  refs: Ref[],
): void {
  if (refs.length === 0) return;
  const ladder = ladderChunkSizes(refs.length, Math.max(1, Math.floor(maxSqlVars / 8)));
  let cursor = 0;
  for (const take of ladder) {
    const chunk = refs.slice(cursor, cursor + take);
    cursor += take;
    const placeholders = getRowPlaceholders(
      '(?, ?, ?, ?, ?, ?, ?, ?)',
      chunk.length,
    );
    const insert = stmt(
      `INSERT INTO refs(from_id, to_name, to_id, call_type, line, lang, module, to_file)
       VALUES ${placeholders}`,
    );
    const binds: (string | number | null)[] = [];
    for (const ref of chunk) {
      binds.push(
        ref.fromId,
        ref.toName,
        ref.toId ?? null,
        ref.callType,
        ref.line,
        ref.lang ?? '',
        ref.module ?? null,
        ref.toFile ?? null,
      );
    }
    insert.run(...binds);
  }
}
