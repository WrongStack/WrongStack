import type { DatabaseSync } from 'node:sqlite';
import { buildIndexableText } from './bm25.js';
import { xxhash64String } from './content-hash.js';
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
import {
  assignRefsToSymbols,
  inListChunks,
  ladderChunkSizes,
  padToInBucket,
  placeholders,
} from './writer-helpers.js';

/** Identity of a declaration across a re-index of its file (ids change every time). */
function rankKey(file: string, name: string, kind: string, scope: string): string {
  return `${file}\u0000${name}\u0000${kind}\u0000${scope}`;
}

function inferIsExportedFlag(s: IndexSymbol): number {
  if (s.isExported !== undefined) return s.isExported ? 1 : 0;
  if (/\b(export|pub|public)\b/.test(s.signature)) return 1;
  if (s.scope === '' && s.lang === 'go' && /^[A-Z]/.test(s.name)) return 1;
  if (s.scope === '' && s.lang === 'py' && !s.name.startsWith('_')) return 1;
  return 0;
}

function computeSymbolSignatureHash(s: IndexSymbol): string {
  if (s.signatureHash) return s.signatureHash;
  const normSig = s.signature.trim().replace(/\s+/g, ' ');
  return xxhash64String(`${s.kind}\u0000${s.scope}\u0000${s.name}\u0000${normSig}`);
}

function inferSymbolEndLines(symbols: readonly IndexSymbol[]): Map<IndexSymbol, number> {
  const result = new Map<IndexSymbol, number>();
  const sorted = [...symbols].sort((a, b) => a.line - b.line);
  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i]!;
    if (typeof s.endLine === 'number' && s.endLine >= s.line) {
      result.set(s, s.endLine);
      continue;
    }
    const next = sorted[i + 1];
    if (next && next.file === s.file && next.line > s.line) {
      result.set(s, Math.max(s.line, next.line - 1));
    } else {
      result.set(s, s.line);
    }
  }
  return result;
}

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
  options: {
    deleteForFiles?: string[] | undefined;
    /**
     * Collect the names whose refs need resolving here instead of resolving
     * them per batch; the caller resolves once after the last batch.
     */
    deferResolution?: Set<string> | undefined;
  } = {},
): IndexSymbol[] {
  if (entries.length === 0 && (options.deleteForFiles?.length ?? 0) === 0) {
    return [];
  }
  const affectedNames = new Set<string>();
  for (const entry of entries) {
    for (const symbol of entry.symbols) affectedNames.add(symbol.name);
    for (const ref of entry.refs) affectedNames.add(ref.toName);
  }
  // Rank rows of the declarations being replaced. Ranks are recomputed only
  // on full or bulk runs, so a watcher re-index used to (a) leave the old ids'
  // `symbol_rank` rows orphaned and (b) drop the file's declarations out of
  // the ranking entirely until the next full run — editing the most central
  // file made it look unranked. They are carried to the new ids by identity.
  const carriedRanks = new Map<string, { rank: number; inDeg: number; outDeg: number }>();
  if (options.deleteForFiles && options.deleteForFiles.length > 0) {
    // P4.12: bucketed chunks — a fitting list stays ONE statement set (IN
    // duplicates are set semantics); an oversized list ladders within budget.
    for (const name of invalidateIncomingRefsForFiles(options.deleteForFiles)) {
      affectedNames.add(name);
    }
    let cursor = 0;
    for (const take of inListChunks(options.deleteForFiles.length, Math.floor(maxSqlVars / 4))) {
      const bucket = padToInBucket(options.deleteForFiles.slice(cursor, cursor + take));
      cursor += take;
      const ph = placeholders(bucket.length);
      const rankRows = stmtFn(
        `SELECT s.file AS file, s.name AS name, s.kind AS kind, s.scope AS scope,
                r.rank AS rank, r.in_deg AS inDeg, r.out_deg AS outDeg
           FROM symbol_rank r JOIN symbols s ON s.id = r.symbol_id
          WHERE s.file IN (${ph})`,
      ).all(...bucket) as Array<{
        file: string;
        name: string;
        kind: string;
        scope: string;
        rank: number;
        inDeg: number;
        outDeg: number;
      }>;
      for (const row of rankRows) {
        const key = rankKey(row.file, row.name, row.kind, row.scope);
        if (!carriedRanks.has(key)) {
          carriedRanks.set(key, { rank: row.rank, inDeg: row.inDeg, outDeg: row.outDeg });
        }
      }
      stmtFn(
        `DELETE FROM symbol_rank WHERE symbol_id IN (SELECT id FROM symbols WHERE file IN (${ph}))`,
      ).run(...bucket);
      if (ftsAvailable) {
        stmtFn(
          `DELETE FROM symbols_fts WHERE rowid IN (SELECT id FROM symbols WHERE file IN (${ph}))`,
        ).run(...bucket);
      }
      if (vectorsAvailable) {
        stmtFn(
          `DELETE FROM symbol_vectors WHERE symbol_id IN (SELECT id FROM symbols WHERE file IN (${ph}))`,
        ).run(...bucket);
      }
      stmtFn(
        `DELETE FROM refs WHERE from_id IN (SELECT id FROM symbols WHERE file IN (${ph}))`,
      ).run(...bucket);
      stmtFn(`DELETE FROM symbols WHERE file IN (${ph})`).run(...bucket);
    }
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
    const endLines = inferSymbolEndLines(entry.symbols);
    for (const s of entry.symbols) {
      const id = nextId++;
      const endLine = endLines.get(s) ?? s.line;
      const isExported = inferIsExportedFlag(s);
      const signatureHash = computeSymbolSignatureHash(s);
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
        endLine,
        isExported,
        signatureHash,
      });
      if (ftsAvailable) {
        ftsRows.push({
          id,
          text: buildIndexableText(s.name, s.signature, s.docComment),
        });
      }
      if (vectorsAvailable) {
        vectorRows.push({
          id,
          vector: encodeVector(embedText(buildIndexableText(s.name, s.signature, s.docComment))),
        });
      }
      const inserted = { ...s, id };
      allInserted.push(inserted);
      insertedForEntry.push(inserted);
    }
    refsToInsert.push(...assignRefsToSymbols(entry.refs, insertedForEntry));
  }

  bulkInsertSymbolsWithStatement((sql) => stmtFn(sql), maxSqlVars, bulkSyms);
  bulkInsertFtsWithStatement((sql) => stmtFn(sql), maxSqlVars, ftsAvailable, ftsRows);
  if (vectorsAvailable) {
    bulkInsertVectorsWithStatement((sql) => stmtFn(sql), maxSqlVars, vectorRows);
  }

  bulkInsertRefsWithStatement((sql) => stmtFn(sql), maxSqlVars, refsToInsert);

  if (carriedRanks.size > 0) {
    const rankRows: Array<[number, number, number, number]> = [];
    for (const symbol of allInserted) {
      const carried = carriedRanks.get(
        rankKey(symbol.file, symbol.name, symbol.kind, symbol.scope),
      );
      if (carried) rankRows.push([symbol.id, carried.rank, carried.inDeg, carried.outDeg]);
    }
    let cursor = 0;
    for (const take of ladderChunkSizes(rankRows.length, Math.max(1, Math.floor(maxSqlVars / 4)))) {
      const chunk = rankRows.slice(cursor, cursor + take);
      cursor += take;
      stmtFn(
        `INSERT OR REPLACE INTO symbol_rank(symbol_id, rank, in_deg, out_deg)
         VALUES ${chunk.map(() => '(?, ?, ?, ?)').join(', ')}`,
      ).run(...chunk.flat());
    }
  }

  const upsertStmt = stmtFn(
    `INSERT INTO files(file, lang, mtime_ms, content_hash, symbol_count, last_indexed, git_blob)
     VALUES (?, ?, ?, ?, ?, ?, '')
     ON CONFLICT(file) DO UPDATE SET
       lang = excluded.lang,
       mtime_ms = excluded.mtime_ms,
       content_hash = excluded.content_hash,
       symbol_count = excluded.symbol_count,
       last_indexed = excluded.last_indexed,
       git_blob = excluded.git_blob`,
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

  // A bulk run defers this: each batch re-resolving every ref named like
  // anything it touched (`push`, `get`, `map`…) rescanned a refs table that
  // grows with every batch — 26 s of an 84 s cold index of this repository.
  // Resolution is by name over NULL refs only, so resolving the union once
  // after the last batch reaches the same answer.
  if (options.deferResolution) {
    for (const name of affectedNames) options.deferResolution.add(name);
  } else {
    resolveRefsForNamesUnsafe(affectedNames);
  }
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
    stmtFn('DELETE FROM symbols_fts WHERE rowid IN (SELECT id FROM symbols WHERE file = ?)').run(
      meta.file,
    );
  }
  if (vectorsAvailable) {
    stmtFn(
      'DELETE FROM symbol_vectors WHERE symbol_id IN (SELECT id FROM symbols WHERE file = ?)',
    ).run(meta.file);
  }
  stmtFn('DELETE FROM refs WHERE from_id IN (SELECT id FROM symbols WHERE file = ?)').run(
    meta.file,
  );
  stmtFn('DELETE FROM symbols WHERE file = ?').run(meta.file);
  stmtFn(
    `INSERT INTO files(file, lang, mtime_ms, content_hash, symbol_count, last_indexed, git_blob)
     VALUES (?, ?, ?, ?, 0, ?, '')
     ON CONFLICT(file) DO UPDATE SET
       lang = excluded.lang,
       mtime_ms = excluded.mtime_ms,
       content_hash = excluded.content_hash,
       symbol_count = 0,
       last_indexed = excluded.last_indexed,
       git_blob = excluded.git_blob`,
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

  const endLines = inferSymbolEndLines(symbols);
  for (const s of symbols) {
    const id = nextId++;
    const endLine = endLines.get(s) ?? s.line;
    const isExported = inferIsExportedFlag(s);
    const signatureHash = computeSymbolSignatureHash(s);
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
      endLine,
      isExported,
      signatureHash,
    });
    if (ftsAvailable) {
      ftsRows.push({ id, text: buildIndexableText(s.name, s.signature, s.docComment) });
    }
    if (vectorsAvailable) {
      vectorRows.push({
        id,
        vector: encodeVector(embedText(buildIndexableText(s.name, s.signature, s.docComment))),
      });
    }
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
    stmtFn('DELETE FROM symbols_fts WHERE rowid IN (SELECT id FROM symbols WHERE file = ?)').run(
      file,
    );
  }
  if (vectorsAvailable) {
    stmtFn(
      'DELETE FROM symbol_vectors WHERE symbol_id IN (SELECT id FROM symbols WHERE file = ?)',
    ).run(file);
  }
  stmtFn('DELETE FROM symbols WHERE file = ?').run(file);
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
    stmtFn('DELETE FROM symbols_fts WHERE rowid IN (SELECT id FROM symbols WHERE file = ?)').run(
      file,
    );
  }
  if (vectorsAvailable) {
    stmtFn(
      'DELETE FROM symbol_vectors WHERE symbol_id IN (SELECT id FROM symbols WHERE file = ?)',
    ).run(file);
  }
  stmtFn('DELETE FROM refs WHERE from_id IN (SELECT id FROM symbols WHERE file = ?)').run(file);
  stmtFn('DELETE FROM symbols WHERE file = ?').run(file);
  stmtFn('DELETE FROM files WHERE file = ?').run(file);
  resolveRefsForNamesUnsafe(affectedNames);
}

export function upsertFileWithStatement(
  stmtFn: (sql: string) => ReturnType<DatabaseSync['prepare']>,
  meta: FileMeta,
): void {
  stmtFn(
    `INSERT INTO files(file, lang, mtime_ms, content_hash, symbol_count, last_indexed, git_blob)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(file) DO UPDATE SET
       lang = excluded.lang,
       mtime_ms = excluded.mtime_ms,
       content_hash = excluded.content_hash,
       symbol_count = excluded.symbol_count,
       last_indexed = excluded.last_indexed,
       git_blob = excluded.git_blob`,
  ).run(
    meta.file,
    meta.lang,
    meta.mtimeMs,
    meta.contentHash ?? '',
    meta.symbolCount,
    meta.lastIndexed,
    meta.gitBlob ?? '',
  );
}

/**
 * Record the Git blob each file's rows were built from ('' clears it). Only
 * the full-run blob pass calls this; see the `files.git_blob` column.
 */
export function setGitBlobsWithStatement(
  stmtFn: (sql: string) => ReturnType<DatabaseSync['prepare']>,
  entries: ReadonlyMap<string, string>,
): void {
  if (entries.size === 0) return;
  const update = stmtFn('UPDATE files SET git_blob = ? WHERE file = ?');
  for (const [file, blob] of entries) update.run(blob, file);
}

export function setFilePackagesWithStatement(
  stmtFn: (sql: string) => ReturnType<DatabaseSync['prepare']>,
  entries: ReadonlyMap<string, string>,
): void {
  if (entries.size === 0) return;
  const update = stmtFn('UPDATE files SET package = ? WHERE file = ?');
  for (const [file, label] of entries) update.run(label, file);
}
