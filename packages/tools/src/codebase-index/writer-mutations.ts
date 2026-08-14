import type { DatabaseSync } from 'node:sqlite';
import { buildIndexableText } from './bm25.js';
import type { FileMeta, Symbol as IndexSymbol, Ref, SymbolLang } from './schema.js';
import { embedText, encodeVector } from './vector-search.js';
import {
  type BulkSymbolRow,
  type BulkVectorRow,
  bulkInsertFtsWithStatement,
  bulkInsertRefsWithStatement,
  bulkInsertSymbolsWithStatement,
  bulkInsertVectorsWithStatement,
} from './writer-bulk-insert.js';
import { assignRefsToSymbols } from './writer-helpers.js';

export function commitBatchWithStatement(
  stmtFn: (sql: string) => ReturnType<DatabaseSync['prepare']>,
  maxSqlVars: number,
  ftsAvailable: boolean,
  vectorsAvailable: boolean,
  allocateSymbolIds: (count: number) => number,
  invalidateIncomingRefsForFiles: (files: readonly string[]) => Set<string>,
  resolveRefsForNamesUnsafe: (names: Iterable<string>) => number,
  entries: Array<{
    file: string;
    lang: SymbolLang;
    symbols: IndexSymbol[];
    refs: Ref[];
    mtimeMs: number;
    symbolCount: number;
    contentHash?: string | undefined;
  }>,
  options: { deleteForFiles?: string[] | undefined } = {},
): IndexSymbol[] {
  if (entries.length === 0 && (options.deleteForFiles?.length ?? 0) === 0) {
    return [];
  }
  const affectedNames = new Set<string>();
  for (const entry of entries) {
    for (const symbol of entry.symbols) affectedNames.add(symbol.name);
    for (const ref of entry.refs) affectedNames.add(ref.toName);
  }
  if (options.deleteForFiles && options.deleteForFiles.length > 0) {
    const placeholders = options.deleteForFiles.map(() => '?').join(',');
    for (const name of invalidateIncomingRefsForFiles(options.deleteForFiles)) {
      affectedNames.add(name);
    }
    if (ftsAvailable) {
      stmtFn(
        `DELETE FROM symbols_fts WHERE rowid IN (SELECT id FROM symbols WHERE file IN (${placeholders}))`,
      ).run(...options.deleteForFiles);
    }
    if (vectorsAvailable) {
      stmtFn(
        `DELETE FROM symbol_vectors WHERE symbol_id IN (SELECT id FROM symbols WHERE file IN (${placeholders}))`,
      ).run(...options.deleteForFiles);
    }
    stmtFn(
      `DELETE FROM refs WHERE from_id IN (SELECT id FROM symbols WHERE file IN (${placeholders}))`,
    ).run(...options.deleteForFiles);
    stmtFn(`DELETE FROM symbols WHERE file IN (${placeholders})`).run(
      ...options.deleteForFiles,
    );
  }

  const totalSymbols = entries.reduce((n, e) => n + e.symbols.length, 0);
  let nextId = allocateSymbolIds(totalSymbols);

  const allInserted: IndexSymbol[] = [];
  const refsToInsert: Ref[] = [];
  const bulkSyms: BulkSymbolRow[] = [];
  const ftsRows: Array<{ id: number; text: string }> = [];
  const vectorRows: BulkVectorRow[] = [];

  for (const entry of entries) {
    const insertedForEntry: IndexSymbol[] = [];
    for (const s of entry.symbols) {
      const id = nextId++;
      bulkSyms.push({
        id,
        lang: s.lang,
        kind: s.kind,
        name: s.name,
        file: s.file,
        line: s.line,
        col: s.col,
        signature: s.signature,
        docComment: s.docComment,
        scope: s.scope,
        text: s.text,
      });
      if (ftsAvailable) {
        ftsRows.push({
          id,
          text: buildIndexableText(s.name, s.signature, s.docComment),
        });
      }
      vectorRows.push({
        id,
        vector: encodeVector(
          embedText(s.text || buildIndexableText(s.name, s.signature, s.docComment)),
        ),
      });
      const inserted = { ...s, id };
      allInserted.push(inserted);
      insertedForEntry.push(inserted);
    }
    refsToInsert.push(...assignRefsToSymbols(entry.refs, insertedForEntry));
  }

  bulkInsertSymbolsWithStatement((sql) => stmtFn(sql), maxSqlVars, bulkSyms);
  bulkInsertFtsWithStatement(
    (sql) => stmtFn(sql),
    maxSqlVars,
    ftsAvailable,
    ftsRows,
  );
  if (vectorsAvailable) {
    bulkInsertVectorsWithStatement(
      (sql) => stmtFn(sql),
      maxSqlVars,
      vectorRows,
    );
  }

  bulkInsertRefsWithStatement((sql) => stmtFn(sql), maxSqlVars, refsToInsert);

  const upsertStmt = stmtFn(
    `INSERT INTO files(file, lang, mtime_ms, content_hash, symbol_count, last_indexed)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(file) DO UPDATE SET
       lang = excluded.lang,
       mtime_ms = excluded.mtime_ms,
       content_hash = excluded.content_hash,
       symbol_count = excluded.symbol_count,
       last_indexed = excluded.last_indexed`,
  );
  const now = Date.now();
  for (const entry of entries) {
    upsertStmt.run(
      entry.file,
      entry.lang,
      entry.mtimeMs,
      entry.contentHash ?? '',
      entry.symbolCount,
      now,
    );
  }

  resolveRefsForNamesUnsafe(affectedNames);
  return allInserted;
}

export function replaceEmptyFileWithStatement(
  stmtFn: (sql: string) => ReturnType<DatabaseSync['prepare']>,
  ftsAvailable: boolean,
  vectorsAvailable: boolean,
  invalidateIncomingRefsForFiles: (files: readonly string[]) => Set<string>,
  resolveRefsForNamesUnsafe: (names: Iterable<string>) => number,
  meta: FileMeta,
): void {
  const affectedNames = invalidateIncomingRefsForFiles([meta.file]);
  if (ftsAvailable) {
    stmtFn(
      'DELETE FROM symbols_fts WHERE rowid IN (SELECT id FROM symbols WHERE file_fk = ?)',
    ).run(meta.file);
  }
  if (vectorsAvailable) {
    stmtFn(
      'DELETE FROM symbol_vectors WHERE symbol_id IN (SELECT id FROM symbols WHERE file_fk = ?)',
    ).run(meta.file);
  }
  stmtFn(
    'DELETE FROM refs WHERE from_id IN (SELECT id FROM symbols WHERE file_fk = ?)',
  ).run(meta.file);
  stmtFn('DELETE FROM symbols WHERE file_fk = ?').run(meta.file);
  stmtFn(
    `INSERT INTO files(file, lang, mtime_ms, content_hash, symbol_count, last_indexed)
     VALUES (?, ?, ?, ?, 0, ?)
     ON CONFLICT(file) DO UPDATE SET
       lang = excluded.lang,
       mtime_ms = excluded.mtime_ms,
       content_hash = excluded.content_hash,
       symbol_count = 0,
       last_indexed = excluded.last_indexed`,
  ).run(meta.file, meta.lang, meta.mtimeMs, meta.contentHash ?? '', meta.lastIndexed);
  resolveRefsForNamesUnsafe(affectedNames);
}

export function insertSymbolsWithStatement(
  stmtFn: (sql: string) => ReturnType<DatabaseSync['prepare']>,
  maxSqlVars: number,
  ftsAvailable: boolean,
  vectorsAvailable: boolean,
  allocateSymbolIds: (count: number) => number,
  symbols: IndexSymbol[],
): IndexSymbol[] {
  let nextId = allocateSymbolIds(symbols.length);
  const result: IndexSymbol[] = [];
  const bulk: BulkSymbolRow[] = [];
  const ftsRows: Array<{ id: number; text: string }> = [];
  const vectorRows: BulkVectorRow[] = [];

  for (const s of symbols) {
    const id = nextId++;
    bulk.push({
      id,
      lang: s.lang,
      kind: s.kind,
      name: s.name,
      file: s.file,
      line: s.line,
      col: s.col,
      signature: s.signature,
      docComment: s.docComment,
      scope: s.scope,
      text: s.text,
    });
    if (ftsAvailable) {
      ftsRows.push({ id, text: buildIndexableText(s.name, s.signature, s.docComment) });
    }
    vectorRows.push({
      id,
      vector: encodeVector(
        embedText(s.text || buildIndexableText(s.name, s.signature, s.docComment)),
      ),
    });
    result.push({ ...s, id });
  }
  bulkInsertSymbolsWithStatement((sql) => stmtFn(sql), maxSqlVars, bulk);
  bulkInsertFtsWithStatement((sql) => stmtFn(sql), maxSqlVars, ftsAvailable, ftsRows);
  if (vectorsAvailable) {
    bulkInsertVectorsWithStatement((sql) => stmtFn(sql), maxSqlVars, vectorRows);
  }
  return result;
}

export function deleteSymbolsForFileWithStatement(
  stmtFn: (sql: string) => ReturnType<DatabaseSync['prepare']>,
  ftsAvailable: boolean,
  vectorsAvailable: boolean,
  invalidateIncomingRefsForFiles: (files: readonly string[]) => Set<string>,
  resolveRefsForNamesUnsafe: (names: Iterable<string>) => number,
  file: string,
): void {
  const affectedNames = invalidateIncomingRefsForFiles([file]);
  if (ftsAvailable) {
    stmtFn(
      'DELETE FROM symbols_fts WHERE rowid IN (SELECT id FROM symbols WHERE file_fk = ?)',
    ).run(file);
  }
  if (vectorsAvailable) {
    stmtFn(
      'DELETE FROM symbol_vectors WHERE symbol_id IN (SELECT id FROM symbols WHERE file_fk = ?)',
    ).run(file);
  }
  stmtFn('DELETE FROM symbols WHERE file_fk = ?').run(file);
  resolveRefsForNamesUnsafe(affectedNames);
}

export function deleteFileWithStatement(
  stmtFn: (sql: string) => ReturnType<DatabaseSync['prepare']>,
  ftsAvailable: boolean,
  vectorsAvailable: boolean,
  invalidateIncomingRefsForFiles: (files: readonly string[]) => Set<string>,
  resolveRefsForNamesUnsafe: (names: Iterable<string>) => number,
  file: string,
): void {
  const affectedNames = invalidateIncomingRefsForFiles([file]);
  if (ftsAvailable) {
    stmtFn(
      'DELETE FROM symbols_fts WHERE rowid IN (SELECT id FROM symbols WHERE file_fk = ?)',
    ).run(file);
  }
  if (vectorsAvailable) {
    stmtFn(
      'DELETE FROM symbol_vectors WHERE symbol_id IN (SELECT id FROM symbols WHERE file_fk = ?)',
    ).run(file);
  }
  stmtFn(
    'DELETE FROM refs WHERE from_id IN (SELECT id FROM symbols WHERE file_fk = ?)',
  ).run(file);
  stmtFn('DELETE FROM symbols WHERE file_fk = ?').run(file);
  stmtFn('DELETE FROM files WHERE file = ?').run(file);
  resolveRefsForNamesUnsafe(affectedNames);
}

export function upsertFileWithStatement(
  stmtFn: (sql: string) => ReturnType<DatabaseSync['prepare']>,
  meta: FileMeta,
): void {
  stmtFn(
    `INSERT INTO files(file, lang, mtime_ms, content_hash, symbol_count, last_indexed)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(file) DO UPDATE SET
       lang = excluded.lang,
       mtime_ms = excluded.mtime_ms,
       content_hash = excluded.content_hash,
       symbol_count = excluded.symbol_count,
       last_indexed = excluded.last_indexed`,
  ).run(
    meta.file,
    meta.lang,
    meta.mtimeMs,
    meta.contentHash ?? '',
    meta.symbolCount,
    meta.lastIndexed,
  );
}

export function setFilePackagesWithStatement(
  stmtFn: (sql: string) => ReturnType<DatabaseSync['prepare']>,
  entries: ReadonlyMap<string, string>,
): void {
  if (entries.size === 0) return;
  const update = stmtFn('UPDATE files SET package = ? WHERE file = ?');
  for (const [file, label] of entries) update.run(label, file);
}

export function applyImportResolutionsWithStatement(
  db: DatabaseSync,
  stmtFn: (sql: string) => ReturnType<DatabaseSync['prepare']>,
  maxSqlVars: number,
  resolutions: ReadonlyArray<{ fromFile: string; lang: string; module: string; toFile: string }>,
): number {
  if (resolutions.length === 0) return 0;
  db.exec('DROP TABLE IF EXISTS temp.import_resolution');
  db.exec(
    `CREATE TEMP TABLE import_resolution (
       from_file TEXT NOT NULL,
       lang TEXT NOT NULL,
       module TEXT NOT NULL,
       to_file TEXT NOT NULL
     )`,
  );
  const chunkSize = Math.max(1, Math.floor(maxSqlVars / 4));
  for (let i = 0; i < resolutions.length; i += chunkSize) {
    const chunk = resolutions.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => '(?, ?, ?, ?)').join(', ');
    const binds: string[] = [];
    for (const entry of chunk) {
      binds.push(entry.fromFile, entry.lang, entry.module, entry.toFile);
    }
    stmtFn(
      `INSERT INTO temp.import_resolution(from_file, lang, module, to_file)
       VALUES ${placeholders}`,
    ).run(...binds);
  }
  db.exec(
    `CREATE INDEX IF NOT EXISTS temp.idx_ir
       ON import_resolution(module, lang, from_file)`,
  );

  const result = stmtFn(
    `UPDATE refs
        SET to_file = (
          SELECT ir.to_file
            FROM temp.import_resolution ir
            JOIN symbols s ON s.id = refs.from_id
           WHERE ir.module = refs.module
             AND ir.lang = refs.lang
             AND ir.from_file = s.file
           LIMIT 1
        )
      WHERE refs.call_type = 'import'
        AND refs.module IS NOT NULL
        AND EXISTS (
          SELECT 1
            FROM temp.import_resolution ir
            JOIN symbols s ON s.id = refs.from_id
           WHERE ir.module = refs.module
             AND ir.lang = refs.lang
             AND ir.from_file = s.file
        )`,
  ).run() as { changes?: number };
  db.exec('DROP TABLE IF EXISTS temp.import_resolution');
  return result.changes ?? 0;
}

