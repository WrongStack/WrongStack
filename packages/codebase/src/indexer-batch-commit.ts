/** The write phase of one indexer batch: per-file outcomes and the batched SQLite commit. */

import { expectDefined } from '@wrongstack/core/utils';
import type { BatchFileRead } from './indexer-batch-read.js';
import { type IndexRunState, isAbortError, noteRewritten } from './indexer-run-state.js';
import {
  assignRefsToSymbols,
  moduleOwnerSymbol,
  needsModuleOwner,
} from './indexer-symbol-ownership.js';
import type { FileMeta, Symbol as IndexSymbol, Ref, SymbolLang } from './schema.js';
import type { IndexStore } from './writer.js';

export function commitBatchResults(
  store: IndexStore,
  run: IndexRunState,
  statReadParse: PromiseSettledResult<BatchFileRead>[],
  batchFiles: string[],
): void {
  const { clearedAll, errors, langStats, existingMeta, deleted, failed, deferredRefNames } = run;
  // Phase 2: Sequential SQLite writes — amortized across the whole batch.
  //
  // Each file is still parsed in parallel (Phase 1), but the writes
  // happen in a single `commitBatch` transaction per outer batch
  // (PARALLEL_BATCH = 20 files). This drops the commit count from
  // ~5/file to 1/parallel-batch, which is the difference between
  // 100 fsync round-trips and 5 on a 20-file slice.
  const batchEntries: Array<{
    file: string;
    lang: SymbolLang;
    symbols: IndexSymbol[];
    refs: Ref[];
    mtimeMs: number;
    symbolCount: number;
    contentHash: string;
  }> = [];
  const deleteForFiles: string[] = [];

  for (let fi = 0; fi < statReadParse.length; fi++) {
    const settled = statReadParse[fi]!;
    const file = expectDefined(batchFiles[fi]);

    if (settled.status === 'rejected') {
      const err = settled.reason;
      if (err instanceof Error && isAbortError(err)) throw err;
      errors.push(`batch error: ${file}: ${err instanceof Error ? err.message : String(err)}`);
      failed.add(file);
      run.filesFailed++;
      continue;
    }

    const result = settled.value;
    if (result.error) {
      // A missing path in a targeted watcher/edit run is authoritative: the
      // source was deleted or renamed, so remove its previous index rows.
      // Read/parse/permission failures are transient and retain the last good
      // snapshot instead of replacing it with an empty one.
      if (result.missing) {
        // A deletion is a successful outcome, not a failure: reporting it as
        // `stat error: ENOENT` made every watcher-observed delete or rename
        // surface as "N error(s)" and count toward `failed`.
        if (existingMeta.has(file)) {
          if (run.prevSymbolsForHeal) {
            for (const sym of store.search('', { file })) {
              run.prevSymbolsForHeal.push({
                name: sym.name,
                kind: sym.kind,
                file: sym.file,
                line: sym.line,
                signature: sym.signature,
              });
            }
          }
          store.deleteFile(file, { deferResolution: deferredRefNames });
          deleted.add(file);
        }
        continue;
      }
      errors.push(`${file}: ${result.error}`);
      failed.add(file);
      run.filesFailed++;
      continue;
    }

    const { stat, lang, parsed } = result;
    if (result.skippedMeta) {
      langStats[lang] = (langStats[lang] ?? 0) + result.skippedMeta.symbolCount;
      run.symbolsIndexed += result.skippedMeta.symbolCount;
      // P5.15: content-hash skips don't count toward filesIndexed.
      run.filesSkipped++;
      // Content-hash short-circuit (Phase 2): mtime changed but content
      // didn't. Persist the new mtime so the next run's fast path hits
      // without re-reading the file.
      const stored = existingMeta.get(file);
      if (stored && stored.mtimeMs !== result.skippedMeta.mtimeMs) {
        store.upsertFile({
          file,
          lang: lang as SymbolLang,
          mtimeMs: result.skippedMeta.mtimeMs,
          symbolCount: result.skippedMeta.symbolCount,
          lastIndexed: Date.now(),
          contentHash: result.skippedMeta.contentHash,
        });
      }
      continue;
    }

    if (!lang || !parsed) {
      if (lang) {
        noteRewritten(run, file, result.contentHash ?? '');
        store.upsertFile({
          file,
          lang: lang as SymbolLang,
          mtimeMs: Math.floor(stat.mtimeMs),
          symbolCount: 0,
          lastIndexed: Date.now(),
          contentHash: result.contentHash ?? '',
        });
        // P5.15: empty files don't count toward filesIndexed.
        run.filesEmpty++;
      }
      continue;
    }

    // Empty symbol files still need their file row updated so future runs
    // know the mtime. Single transaction clears stale rows + upserts meta.
    const parsedRefs = parsed.refs ?? [];
    if (parsed.symbols.length === 0 && parsedRefs.length === 0) {
      noteRewritten(run, file, result.contentHash ?? '');
      // After a clear there are no old rows to drop, and the drop's lookups
      // would scan the unindexed tables once per empty file.
      const writeEmpty = clearedAll
        ? (meta: FileMeta) => store.upsertFile(meta)
        : (meta: FileMeta) => store.replaceEmptyFile(meta);
      writeEmpty({
        file,
        lang: lang as SymbolLang,
        mtimeMs: Math.floor(stat.mtimeMs),
        symbolCount: 0,
        lastIndexed: Date.now(),
        contentHash: result.contentHash ?? '',
      });
      // P5.15: empty files don't count toward filesIndexed.
      run.filesEmpty++;
      continue;
    }

    const symbols = needsModuleOwner(parsed.symbols, parsedRefs)
      ? [moduleOwnerSymbol(file, lang as SymbolLang), ...parsed.symbols]
      : parsed.symbols;
    batchEntries.push({
      file,
      lang: lang as SymbolLang,
      symbols,
      refs: parsedRefs,
      mtimeMs: Math.floor(stat.mtimeMs),
      symbolCount: symbols.length,
      contentHash: result.contentHash ?? '',
    });
    deleteForFiles.push(file);
    noteRewritten(run, file, result.contentHash ?? '');
  }

  if (batchEntries.length > 0) {
    if (!clearedAll && run.prevSymbolsForHeal && run.nextSymbolsForHeal) {
      for (const file of deleteForFiles) {
        if (!existingMeta.has(file)) continue;
        for (const sym of store.search('', { file })) {
          run.prevSymbolsForHeal.push({
            name: sym.name,
            kind: sym.kind,
            file: sym.file,
            line: sym.line,
            signature: sym.signature,
          });
        }
      }
      for (const entry of batchEntries) {
        for (const sym of entry.symbols) {
          run.nextSymbolsForHeal.push({
            name: sym.name,
            kind: sym.kind,
            file: sym.file,
            line: sym.line,
            signature: sym.signature,
          });
        }
      }
    }
    try {
      store.commitBatch(batchEntries, {
        // Nothing to replace after a clear (and no index to find it by).
        deleteForFiles: clearedAll ? undefined : deleteForFiles,
        deferResolution: deferredRefNames,
      });
      for (const entry of batchEntries) {
        const count = entry.symbols.length;
        run.symbolsIndexed += count;
        langStats[entry.lang] = (langStats[entry.lang] ?? 0) + count;
        run.filesIndexed++;
        run.filesParsed++;
      }
    } catch (err) {
      // If the batch commit fails, fall back to per-file writes so the
      // user still gets a partial index. Per-file writes are slower but
      // isolate failures.
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`commitBatch failed: ${message} — falling back to per-file writes`);
      for (const entry of batchEntries) {
        try {
          store.deleteRefsForFile(entry.file);
          store.deleteSymbolsForFile(entry.file);
          const symbolsWithIds = store.insertSymbols(entry.symbols);
          run.symbolsIndexed += symbolsWithIds.length;
          langStats[entry.lang] = (langStats[entry.lang] ?? 0) + symbolsWithIds.length;
          run.filesIndexed++;
          run.filesParsed++;
          if (entry.refs.length > 0 && symbolsWithIds.length > 0) {
            const fallbackBatch = assignRefsToSymbols(entry.refs, symbolsWithIds);
            if (fallbackBatch.length > 0) store.insertRefsBatch(fallbackBatch);
          }
          store.resolveRefsForNames([
            ...entry.symbols.map((symbol) => symbol.name),
            ...entry.refs.map((ref) => ref.toName),
          ]);
          store.upsertFile({
            file: entry.file,
            lang: entry.lang,
            mtimeMs: entry.mtimeMs,
            symbolCount: entry.symbolCount,
            lastIndexed: Date.now(),
            contentHash: entry.contentHash,
          });
        } catch (innerErr) {
          failed.add(entry.file);
          run.filesFailed++;
          errors.push(
            `fallback write failed: ${entry.file}: ${innerErr instanceof Error ? innerErr.message : String(innerErr)}`,
          );
        }
      }
    }
  }
}
