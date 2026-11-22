import type { DatabaseSync } from 'node:sqlite';
import { inListChunks, padToInBucket, placeholders } from './writer-helpers.js';
import { NEXT_SYMBOL_ID_KEY } from './writer-init.js';

export interface IndexDeletionHost {
  readonly maxSqlVars: number;
  stmt(sql: string): ReturnType<DatabaseSync['prepare']>;
  invalidateBm25(): void;
  runWriteTransaction<T>(operation: () => T): T;
  invalidateIncomingRefsForFiles(files: readonly string[]): Set<string>;
  readonly ftsAvailable: boolean;
  readonly vectorsAvailable: boolean;
  recordFtsChurn(rows: number): void;
  resolveRefsForNamesUnsafe(names: Iterable<string>): number;
  readonly db: DatabaseSync;
  readonly stmtCache: Map<string, ReturnType<DatabaseSync['prepare']>>;
  initSchema(): void;
}

export function invalidateIncomingIndexRefs(
  host: IndexDeletionHost,
  files: readonly string[],
): Set<string> {
  if (files.length === 0) return new Set();
  // P4.12: bucketed chunks — a fitting list stays ONE statement pair (IN
  // duplicates are set semantics); an oversized list ladders within budget.
  const names: string[] = [];
  let cursor = 0;
  for (const take of inListChunks(files.length, host.maxSqlVars)) {
    const bucket = padToInBucket(files.slice(cursor, cursor + take));
    cursor += take;
    const ph = placeholders(bucket.length);
    for (const row of host
      .stmt(`SELECT DISTINCT name FROM symbols WHERE file IN (${ph})`)
      .all(...bucket) as Array<{ name: string }>) {
      names.push(row.name);
    }
    host
      .stmt(
        `UPDATE refs SET to_id = NULL
         WHERE to_id IN (SELECT id FROM symbols WHERE file IN (${ph}))`,
      )
      .run(...bucket);
  }
  return new Set(names);
}

export function deleteFileSymbols(host: IndexDeletionHost, file: string): void {
  host.invalidateBm25();
  host.runWriteTransaction(() => {
    const affectedNames = host.invalidateIncomingRefsForFiles([file]);
    if (host.ftsAvailable) {
      host
        .stmt('DELETE FROM symbols_fts WHERE rowid IN (SELECT id FROM symbols WHERE file = ?)')
        .run(file);
    }
    if (host.vectorsAvailable) {
      host
        .stmt(
          'DELETE FROM symbol_vectors WHERE symbol_id IN (SELECT id FROM symbols WHERE file = ?)',
        )
        .run(file);
    }
    host
      .stmt('DELETE FROM symbol_rank WHERE symbol_id IN (SELECT id FROM symbols WHERE file = ?)')
      .run(file);
    const deletedChanges = Number(
      host.stmt('DELETE FROM symbols WHERE file = ?').run(file).changes,
    );
    host.recordFtsChurn(deletedChanges);
    host.resolveRefsForNamesUnsafe(affectedNames);
  });
}

/**
 * Remove one file's rows. References that pointed into it are re-resolved by name right
 * away, unless `deferResolution` collects those names for the run's single pass: that
 * re-resolution scans the whole ref table, so per file it made deleting N files cost N
 * scans (a cleanup of thousands of stale files blocked the index server for minutes).
 */
export function deleteIndexedFile(
  host: IndexDeletionHost,
  file: string,
  deferResolution?: Set<string>,
): void {
  host.invalidateBm25();
  host.runWriteTransaction(() => {
    const affectedNames = host.invalidateIncomingRefsForFiles([file]);
    if (host.ftsAvailable) {
      host
        .stmt('DELETE FROM symbols_fts WHERE rowid IN (SELECT id FROM symbols WHERE file = ?)')
        .run(file);
    }
    if (host.vectorsAvailable) {
      host
        .stmt(
          'DELETE FROM symbol_vectors WHERE symbol_id IN (SELECT id FROM symbols WHERE file = ?)',
        )
        .run(file);
    }
    host
      .stmt('DELETE FROM refs WHERE from_id IN (SELECT id FROM symbols WHERE file = ?)')
      .run(file);
    // Rank rows go with their symbols and file: left behind, the rank
    // readers returned deleted files until the next full run.
    host
      .stmt('DELETE FROM symbol_rank WHERE symbol_id IN (SELECT id FROM symbols WHERE file = ?)')
      .run(file);
    host.stmt('DELETE FROM file_rank WHERE file = ?').run(file);
    const deletedChanges = Number(
      host.stmt('DELETE FROM symbols WHERE file = ?').run(file).changes,
    );
    host.recordFtsChurn(deletedChanges);
    host.stmt('DELETE FROM files WHERE file = ?').run(file);
    if (deferResolution) for (const name of affectedNames) deferResolution.add(name);
    else host.resolveRefsForNamesUnsafe(affectedNames);
  });
}

export function clearIndex(host: IndexDeletionHost): void {
  host.invalidateBm25();
  host.runWriteTransaction(() => {
    host.db.exec('DROP TABLE IF EXISTS refs');
    host.db.exec('DROP TABLE IF EXISTS symbols');
    host.db.exec('DROP TABLE IF EXISTS files');
    host.db.exec('DROP TABLE IF EXISTS metadata');
    if (host.ftsAvailable) host.db.exec('DROP TABLE IF EXISTS symbols_fts');
    host.db.exec('DROP TABLE IF EXISTS symbol_vectors');
    host.db.exec('DROP TABLE IF EXISTS symbol_rank');
    host.db.exec('DROP TABLE IF EXISTS file_rank');
    host.db.exec('DROP TABLE IF EXISTS file_concepts');
    host.db.exec('DROP TABLE IF EXISTS subsystems');
    host.db.exec('DROP TABLE IF EXISTS concept_edges');
    host.db.exec('DROP TABLE IF EXISTS file_vectors');
    host.stmtCache.clear();
    host.initSchema();
    host
      .stmt('INSERT OR REPLACE INTO metadata(key, value) VALUES (?, ?)')
      .run(NEXT_SYMBOL_ID_KEY, '1');
  });
}
