import type { DatabaseSync } from 'node:sqlite';

import type { FileMeta, Symbol as IndexSymbol, Ref, SymbolLang } from './schema.js';

import { inListChunks, placeholders } from './writer-helpers.js';

import { commitBatchWithStatement } from './writer-mutations.js';

export interface IndexStoreBatchesHost {
  maxSqlVars: number;
  invalidateBm25: () => void;
  runWriteTransaction: <T>(operation: () => T) => T;
  stmt: (sql: string) => ReturnType<DatabaseSync['prepare']>;
  ftsAvailable: boolean;
  vectorsAvailable: boolean;
  allocateSymbolIds: (count: number) => number;
  invalidateIncomingRefsForFiles: (files: readonly string[]) => Set<string>;
  resolveRefsForNamesUnsafe: (names: Iterable<string>) => number;
  recordFtsChurn: (rows: number) => void;
}
export function commitBatch(
  host: IndexStoreBatchesHost,
  entries: Array<{
    file: string;
    lang: SymbolLang;
    symbols: IndexSymbol[];
    refs: Ref[];
    mtimeMs: number;
    symbolCount: number;
    contentHash?: string | undefined;
  }>,
  options: {
    deleteForFiles?: string[] | undefined;
    deferResolution?: Set<string> | undefined;
  } = {},
): IndexSymbol[] {
  host.invalidateBm25();
  return host.runWriteTransaction(() => {
    const owned = options.deleteForFiles?.length ?? 0;
    let churnRows = entries.reduce((sum, e) => sum + e.symbols.length, 0);
    // P2 review fix: deleteForFiles removes FTS rows too. Count those
    // pre-existing rows (pre-DELETE, inside this transaction) so
    // delete-only batches can also cross the maintenance gate.
    if (owned > 0) {
      let cursor = 0;
      for (const take of inListChunks(owned, Math.floor(host.maxSqlVars / 4))) {
        const bucket = options.deleteForFiles!.slice(cursor, cursor + take);
        cursor += take;
        const row = host
          .stmt(`SELECT COUNT(*) AS n FROM symbols WHERE file IN (${placeholders(bucket.length)})`)
          .get(...bucket) as { n?: number } | undefined;
        churnRows += Number(row?.n ?? 0);
      }
    }
    const result = commitBatchWithStatement(
      (sql) => host.stmt(sql),
      host.maxSqlVars,
      host.ftsAvailable,
      host.vectorsAvailable,
      host.allocateSymbolIds.bind(host),
      host.invalidateIncomingRefsForFiles.bind(host),
      host.resolveRefsForNamesUnsafe.bind(host),
      entries,
      options,
    );
    host.recordFtsChurn(churnRows);
    return result;
  });
}

export function replaceEmptyFile(host: IndexStoreBatchesHost, meta: FileMeta): void {
  host.invalidateBm25();
  host.runWriteTransaction(() => {
    const affectedNames = host.invalidateIncomingRefsForFiles([meta.file]);
    if (host.ftsAvailable) {
      host
        .stmt('DELETE FROM symbols_fts WHERE rowid IN (SELECT id FROM symbols WHERE file = ?)')
        .run(meta.file);
    }
    if (host.vectorsAvailable) {
      host
        .stmt(
          'DELETE FROM symbol_vectors WHERE symbol_id IN (SELECT id FROM symbols WHERE file = ?)',
        )
        .run(meta.file);
    }
    host
      .stmt('DELETE FROM refs WHERE from_id IN (SELECT id FROM symbols WHERE file = ?)')
      .run(meta.file);
    host
      .stmt('DELETE FROM symbol_rank WHERE symbol_id IN (SELECT id FROM symbols WHERE file = ?)')
      .run(meta.file);
    const deletedChanges = Number(
      host.stmt('DELETE FROM symbols WHERE file = ?').run(meta.file).changes,
    );
    host.recordFtsChurn(deletedChanges);
    host
      .stmt(
        `INSERT INTO files(file, lang, mtime_ms, content_hash, symbol_count, last_indexed, git_blob)
           VALUES (?, ?, ?, ?, ?, ?, '')
           ON CONFLICT(file) DO UPDATE SET
             lang = excluded.lang,
             mtime_ms = excluded.mtime_ms,
             content_hash = excluded.content_hash,
             symbol_count = excluded.symbol_count,
             last_indexed = excluded.last_indexed,
             git_blob = excluded.git_blob`,
      )
      .run(
        meta.file,
        meta.lang,
        meta.mtimeMs,
        meta.contentHash ?? '',
        meta.symbolCount,
        meta.lastIndexed,
      );
    host.resolveRefsForNamesUnsafe(affectedNames);
  });
}
