import { expectDefined } from '@wrongstack/core';
/**
 * Main indexing orchestrator.
 *
 * Given a project root and a list of files:
 * 1. Parse each file with the appropriate parser (TS, Go, Python, Rust, JSON, YAML)
 * 2. Delete old symbols for changed/deleted files
 * 3. Insert new symbols
 * 4. Update file metadata
 * 5. Return index statistics
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Dirent, Stats } from 'node:fs';
import type { Context } from '@wrongstack/core';
import { compileGlob } from '@wrongstack/core';
import type { FileMeta, IndexResult, Ref, Symbol as IndexSymbol, SymbolLang } from './schema.js';
import { IndexStore } from './writer.js';
import { parseSymbols as parseTs, detectLang } from './ts-parser.js';
import { parseSymbols as parseGo } from './go-parser.js';
import { parseSymbols as parsePy } from './py-parser.js';
import { parseSymbols as parseRs } from './rs-parser.js';
import { parseSymbols as parseJson } from './json-parser.js';
import { parseSymbols as parseYaml } from './yaml-parser.js';
import { loadGitignoreMatcher, type IgnoreMatcher } from './gitignore.js';
/** Yield the event loop every N files so the main thread stays responsive. */
const YIELD_EVERY_N = 50;
const PARALLEL_BATCH = 20;

function yieldEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Cooperatively abort if the signal is set. Throws with the signal's reason
 * (or a descriptive Error) so callers know *why* the operation was cancelled.
 * Called at yield points — never after a Promise resolve (that would be a
 * microtask that the signal check could miss).
 */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error(
    typeof signal.reason === 'string' ? signal.reason : 'Indexing cancelled',
  );
}

/**
 * Detect AbortError (DOMException with name 'AbortError') thrown by signal-aware
 * fs.promises calls (stat, readFile). We must re-throw these so the cancellation
 * propagates — catching them as ordinary errors would keep the loop running.
 */
function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

const DEFAULT_IGNORE = [
  'node_modules', '.git', 'dist', 'build', '.next', 'coverage',
  '.turbo', '__snapshots__', '.nyc_output',
];

interface IndexerOptions {
  projectRoot: string;
  files?: string[] | undefined;
  force?: boolean | undefined;
  langs?: string[] | undefined;
  ignore?: string[] | undefined;
  /** Override the index directory (default: the global per-project dir). */
  indexDir?: string | undefined;
  /**
   * Signal that cancels indexing cooperatively. Polled at yield points
   * (file walk, per-file loop) so a hung filesystem won't lock up the
   * process. When the tool executor's timeout fires, this signal aborts
   * and `runIndexer` throws, releasing the mutex and resetting flags.
   */
  signal?: AbortSignal | undefined;
  /**
   * Per-file progress callback. Injected by the caller instead of imported
   * from the host's module state so the indexer can run inside a worker
   * thread (worker posts progress messages; inline host updates its state).
   */
  onProgress?: ((current: number, total: number) => void) | undefined;
}

async function findSourceFiles(
  projectRoot: string,
  ignore: string[],
  isGitIgnored: IgnoreMatcher,
  signal?: AbortSignal | undefined,
): Promise<string[]> {
  const results: string[] = [];
  const ignoreSet = new Set([...DEFAULT_IGNORE, ...ignore]);
  // compileGlob does not support brace expansion — use one pattern per extension
  const globs = [
    { ext: '.ts',   pat: compileGlob('**/*.ts') },
    { ext: '.tsx',  pat: compileGlob('**/*.tsx') },
    { ext: '.js',   pat: compileGlob('**/*.js') },
    { ext: '.jsx',  pat: compileGlob('**/*.jsx') },
    { ext: '.go',   pat: compileGlob('**/*.go') },
    { ext: '.py',   pat: compileGlob('**/*.py') },
    { ext: '.rs',   pat: compileGlob('**/*.rs') },
    { ext: '.json', pat: compileGlob('**/*.json') },
    { ext: '.yaml', pat: compileGlob('**/*.yaml') },
    { ext: '.yml',  pat: compileGlob('**/*.yml') },
  ];

  let dirCount = 0;

  const walk = async (dir: string): Promise<void> => {
    // Yield + abort check before every readdir so a cancelled indexer
    // doesn't descend deeper into the tree.
    throwIfAborted(signal);
    // Periodically yield the event loop so the main thread stays responsive
    // during deep directory walks (Node 22's fs.promises.readdir doesn't
    // accept AbortSignal, so we rely on cooperative polling).
    if (dirCount > 0 && dirCount % YIELD_EVERY_N === 0) {
      await yieldEventLoop();
      throwIfAborted(signal);
    }
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    dirCount++;

    for (const e of entries) {
      if (ignoreSet.has(e.name)) continue;
      const full = path.join(dir, e.name);
      // Normalize to forward-slash relative path for pattern matching
      const rel = path.relative(projectRoot, full).replace(/\\/g, '/');
      if (e.isDirectory()) {
        // Prune .gitignore'd directories before descending (skips node_modules,
        // build output, and any project-specific ignored dirs).
        if (isGitIgnored(rel, true)) continue;
        await walk(full);
      } else if (e.isFile()) {
        if (isGitIgnored(rel, false)) continue;
        const ext = path.extname(e.name);
        for (const { ext: extName, pat } of globs) {
          if (ext === extName && (pat.test(rel) || pat.test(e.name))) {
            results.push(full);
            break;
          }
        }
      }
    }
  };

  await walk(projectRoot);
  return results;
}

/** Dispatch to the correct parser based on language. */
async function parseFile(
  file: string,
  content: string,
  lang: string,
): Promise<ReturnType<typeof parseTs>> {
  switch (lang) {
    case 'ts':
    case 'tsx':
    case 'js':
    case 'jsx':
      return parseTs({ file, content, lang: lang as 'ts' | 'tsx' | 'js' | 'jsx' });
    case 'go':
      return parseGo({ file, content, lang: 'go' });
    case 'py':
      return parsePy({ file, content, lang: 'py' });
    case 'rs':
      return parseRs({ file, content, lang: 'rs' });
    case 'json':
      return parseJson({ file, content, lang: 'json' });
    case 'yaml':
      return parseYaml({ file, content, lang: 'yaml' });
    default:
      return { file, lang: lang as 'ts' | 'tsx' | 'js' | 'jsx', symbols: [], mtimeMs: Date.now() };
  }
}

/** Run a full or incremental index and return statistics. */
export async function runIndexer(
  _ctx: Context,
  opts: IndexerOptions,
): Promise<IndexResult> {
  const store = new IndexStore(opts.projectRoot, { indexDir: opts.indexDir });
  try {
    return await runIndexerWithStore(store, opts);
  } finally {
    // Always release the synchronous SQLite connection — an abort mid-run
    // (executor timeout, session teardown) previously leaked it.
    try {
      store.close();
    } catch {
      /* already closed */
    }
  }
}

async function runIndexerWithStore(store: IndexStore, opts: IndexerOptions): Promise<IndexResult> {
  const { projectRoot, force = false, langs, ignore = [], signal } = opts;
  const startMs = Date.now();
  const errors: string[] = [];
  const langStats: Record<string, number> = {};
  let filesIndexed = 0;
  let symbolsIndexed = 0;

  // Honor the project-root .gitignore (skips node_modules, build output, and
  // any project-specific ignored paths) on top of the always-on DEFAULT_IGNORE.
  const isGitIgnored = await loadGitignoreMatcher(projectRoot);

  let files: string[];
  /** Set of all files discovered on disk (before language filtering).
   *  Used for O(1) stale-file detection instead of stat-ing every
   *  previously-indexed file. Null when an explicit file list was given. */
  let discoveredFiles: Set<string> | null = null;
  if (opts.files && opts.files.length > 0) {
    // Explicit file list (per-edit / watcher path): drop any that are gitignored
    // so an ignored file edited in the editor never enters the index.
    files = opts.files
      .map((f) => path.resolve(projectRoot, f))
      .filter((f) => !isGitIgnored(path.relative(projectRoot, f).replace(/\\/g, '/'), false));
  } else {
    files = await findSourceFiles(projectRoot, ignore, isGitIgnored, signal);
    discoveredFiles = new Set(files);
  }

  if (langs && langs.length > 0) {
    const langSet = new Set(langs);
    files = files.filter((f) => {
      const lang = detectLang(f);
      return lang ? langSet.has(lang) : false;
    });
  }

  if (force) store.clearAll();

  // Collect existing file metadata for incremental check
  const existingMeta: Map<string, FileMeta> = new Map();
  if (!force) {
    for (const meta of store.getAllFileMetas()) existingMeta.set(meta.file, meta);
  }

  // Process files in batches for parallel I/O and parsing.
  // SQLite writes remain sequential (they're synchronous and CPU-bound).
  for (let batchStart = 0; batchStart < files.length; batchStart += PARALLEL_BATCH) {
    const batchEnd = Math.min(batchStart + PARALLEL_BATCH, files.length);
    const batchFiles = files.slice(batchStart, batchEnd);

    // Report progress to the caller so UIs can show indexing status.
    opts.onProgress?.(batchEnd, files.length);

    // Yield the event loop periodically so the main thread stays responsive
    // (TUI rendering, input handling, etc.) during large index builds.
    // Also check for cancellation — the tool executor's timeout or a
    // session abort propagates through `signal`.
    if (batchStart > 0 && batchStart % YIELD_EVERY_N === 0) {
      await yieldEventLoop();
      throwIfAborted(signal);
    }

    // Phase 1: Parallel stat + incremental skip + read + parse
    const statOpts = signal ? { signal } : {};
    const statReadParse = await Promise.allSettled(
      batchFiles.map(async (file): Promise<{ file: string; stat: Stats; lang: string; parsed: Awaited<ReturnType<typeof parseFile>> | null; content?: string; skippedMeta?: FileMeta; error?: string }> => {
        let stat: Stats;
        try {
          stat = await (fs.stat as (path: string, opts: { signal?: AbortSignal }) => Promise<Stats>)(file, statOpts);
        } catch (e) {
          if (isAbortError(e)) throw e;
          return { file, stat: null as never as Stats, lang: '', parsed: null, error: `stat error: ${e instanceof Error ? e.message : String(e)}` };
        }
        if (!stat.isFile()) return { file, stat, lang: '', parsed: null };

        const lang = detectLang(file);
        if (!lang) return { file, stat, lang: '', parsed: null };

        const meta = existingMeta.get(file);
        if (!force && meta && meta.mtimeMs === Math.floor(stat.mtimeMs)) {
          return { file, stat, lang, parsed: null, skippedMeta: meta };
        }

        let content: string;
        try {
          content = await fs.readFile(file, { encoding: 'utf8', signal });
        } catch (e) {
          if (isAbortError(e)) throw e;
          return { file, stat, lang, parsed: null, error: `read error: ${e instanceof Error ? e.message : String(e)}` };
        }

        let parsed: Awaited<ReturnType<typeof parseFile>>;
        try {
          parsed = await parseFile(file, content, lang);
        } catch (e) {
          return { file, stat, lang, parsed: null, error: `parse error: ${e instanceof Error ? e.message : String(e)}` };
        }
        return { file, stat, lang, parsed, content };
      })
    );

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
    }> = [];
    const deleteForFiles: string[] = [];

    for (let fi = 0; fi < statReadParse.length; fi++) {
      const settled = statReadParse[fi]!;
      const file = expectDefined(batchFiles[fi]);

      if (settled.status === 'rejected') {
        const err = settled.reason;
        if (err instanceof Error && isAbortError(err)) throw err;
        errors.push(`batch error: ${file}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }

      const result = settled.value;
      if (result.error) {
        if (result.stat) store.deleteFile(file);
        if (result.error.includes('error:')) errors.push(result.error);
        continue;
      }

      const { stat, lang, parsed } = result;
      if (result.skippedMeta) {
        langStats[lang] = (langStats[lang] ?? 0) + result.skippedMeta.symbolCount;
        symbolsIndexed += result.skippedMeta.symbolCount;
        filesIndexed++;
        continue;
      }

      if (!lang || !parsed) {
        if (lang) {
          store.upsertFile({
            file,
            lang: lang as SymbolLang,
            mtimeMs: Math.floor(stat.mtimeMs),
            symbolCount: 0,
            lastIndexed: Date.now(),
          });
          filesIndexed++;
        }
        continue;
      }

      // Empty symbol files still need their file row updated so future runs
      // know the mtime. They don't contribute any symbols or refs, so we
      // upsert directly without scheduling them for the batch.
      if (parsed.symbols.length === 0) {
        store.upsertFile({
          file,
          lang: lang as SymbolLang,
          mtimeMs: Math.floor(stat.mtimeMs),
          symbolCount: 0,
          lastIndexed: Date.now(),
        });
        filesIndexed++;
        continue;
      }

      // Pre-compute the refs batch with placeholder fromId=0 — we'll
      // remap fromId after `commitBatch` assigns real ids.
      const refs: Ref[] = [];
      if (parsed.refs && parsed.refs.length > 0) {
        for (const r of parsed.refs) refs.push({ ...r, fromId: 0 });
      }

      batchEntries.push({
        file,
        lang: lang as SymbolLang,
        symbols: parsed.symbols,
        refs,
        mtimeMs: Math.floor(stat.mtimeMs),
        symbolCount: parsed.symbols.length,
      });
      deleteForFiles.push(file);
    }

    if (batchEntries.length > 0) {
      try {
        const inserted = store.commitBatch(batchEntries, { deleteForFiles });
        // inserted is the full list of inserted symbols in order; the
        // caller assigned one id per entry.symbols in iteration order, so
        // we can split it back per-file for the refs remap.
        let cursor = 0;
        for (const entry of batchEntries) {
          const count = entry.symbols.length;
          const symbolsWithIds = inserted.slice(cursor, cursor + count);
          cursor += count;

          symbolsIndexed += count;
          langStats[entry.lang] = (langStats[entry.lang] ?? 0) + count;
          filesIndexed++;

          // Map refs to their real fromId. Refs were grouped per-line in
          // the parser, so we can reindex by line.
          if (entry.refs.length > 0 && symbolsWithIds.length > 0) {
            const refsByLine = new Map<number, number[]>();
            for (let i = 0; i < symbolsWithIds.length; i++) {
              const sym = symbolsWithIds[i]!;
              let arr = refsByLine.get(sym.line);
              if (!arr) {
                arr = [];
                refsByLine.set(sym.line, arr);
              }
              arr.push(i);
            }
            for (const ref of entry.refs) {
              const indices = refsByLine.get(ref.line);
              if (indices && indices.length > 0) {
                // Pop the next index — refs with the same line get distinct
                // symbols in their source order. (Symbols are already ordered
                // by line, then by parser output order.)
                const idx = indices.shift()!;
                ref.fromId = symbolsWithIds[idx]!.id;
              }
            }
          }
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
            symbolsIndexed += symbolsWithIds.length;
            langStats[entry.lang] = (langStats[entry.lang] ?? 0) + symbolsWithIds.length;
            filesIndexed++;
            if (entry.refs.length > 0 && symbolsWithIds.length > 0) {
              const refsByLine = new Map<number, IndexSymbol[]>();
              for (const sym of symbolsWithIds) {
                let arr = refsByLine.get(sym.line);
                if (!arr) {
                  arr = [];
                  refsByLine.set(sym.line, arr);
                }
                arr.push(sym);
              }
              const fallbackBatch: Ref[] = [];
              for (const ref of entry.refs) {
                const syms = refsByLine.get(ref.line);
                if (syms && syms.length > 0) {
                  const sym = syms.shift()!;
                  fallbackBatch.push({ ...ref, fromId: sym.id });
                }
              }
              if (fallbackBatch.length > 0) store.insertRefsBatch(fallbackBatch);
            }
            store.upsertFile({
              file: entry.file,
              lang: entry.lang,
              mtimeMs: entry.mtimeMs,
              symbolCount: entry.symbolCount,
              lastIndexed: Date.now(),
            });
          } catch (innerErr) {
            errors.push(`fallback write failed: ${entry.file}: ${innerErr instanceof Error ? innerErr.message : String(innerErr)}`);
          }
        }
      }
    }
  }

  // Remove stale entries for files deleted since last run.
  // Instead of stat-ing every previously-indexed file (O(total indexed)),
  // derive stale files from the discovered set: any existingMeta entry not
  // in the scanned files is stale. Skip entirely for explicit file lists
  // (targeted reindex — can't derive stale from a subset).
  if (discoveredFiles) {
    for (const [file_] of existingMeta) {
      if (!discoveredFiles.has(file_)) {
        store.deleteFile(file_);
      }
    }
  }

  const durationMs = Date.now() - startMs;
  store.setLastIndexed(Date.now());

  return {
    filesIndexed,
    symbolsIndexed,
    langStats,
    durationMs,
    errors,
  };
}