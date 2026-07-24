import { expectDefined } from '@wrongstack/core/utils';
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
import { availableParallelism } from 'node:os';
import type { Dirent, Stats } from 'node:fs';
import type { Context } from '@wrongstack/core/agent';
import { DEFAULT_WALK_IGNORE_DIRS, indexParallelBatchSize, isFrugalPerf } from '@wrongstack/core/utils';
import type { FileMeta, IndexResult, Ref, Symbol as IndexSymbol, SymbolLang } from './schema.js';
import { IndexStore } from './writer.js';
import { parseSymbols as parseTs } from './ts-parser.js';
import { detectLang, INDEXABLE_EXTENSIONS } from './languages.js';
import { parseSymbols as parseGo } from './go-parser.js';
import { parseSymbols as parsePy } from './py-parser.js';
import { parseSymbols as parseRs } from './rs-parser.js';
import { parseSymbols as parseJson } from './json-parser.js';
import { parseSymbols as parseYaml } from './yaml-parser.js';
import { parseSymbols as parseGeneric } from './generic-parser.js';
import { loadGitignoreMatcher, type IgnoreMatcher } from './gitignore.js';
/** Yield the event loop every N files so the main thread stays responsive. */
const YIELD_EVERY_N = 50;

/**
 * Parallel parse batch size — see {@link indexParallelBatchSize}.
 * Re-resolved at the start of each index run so env profile changes apply.
 */
export function resolveParallelBatch(): number {
  return indexParallelBatchSize(availableParallelism());
}

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
  throw new Error(typeof signal.reason === 'string' ? signal.reason : 'Indexing cancelled');
}

/**
 * Detect AbortError (DOMException with name 'AbortError') thrown by signal-aware
 * fs.promises calls (stat, readFile). We must re-throw these so the cancellation
 * propagates — catching them as ordinary errors would keep the loop running.
 */
function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

const DEFAULT_IGNORE = DEFAULT_WALK_IGNORE_DIRS;
const DEFAULT_IGNORE_FILES = new Set(['package-lock.json', 'pnpm-lock.yaml', 'pnpm-lock.yml']);
const MAX_INDEX_FILE_BYTES = 5 * 1024 * 1024;

function isWithinProject(projectRoot: string, file: string): boolean {
  const rel = path.relative(projectRoot, file);
  return rel !== '' && !rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel);
}

function isMissingPathError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

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
): Promise<{ files: string[]; complete: boolean; errors: string[] }> {
  const results: string[] = [];
  const errors: string[] = [];
  let complete = true;
  const ignoreSet = new Set([...DEFAULT_IGNORE, ...ignore]);
  // Extension allow-list from languages.ts — every mapped language is discovered.
  // Special filenames (Makefile, Dockerfile, …) are accepted via detectLang.
  const indexableExts = new Set(INDEXABLE_EXTENSIONS);

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
    } catch (err) {
      complete = false;
      errors.push(`scan error: ${dir}: ${err instanceof Error ? err.message : String(err)}`);
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
        if (DEFAULT_IGNORE_FILES.has(e.name) || isGitIgnored(rel, false)) continue;
        const ext = path.extname(e.name).toLowerCase();
        // Fast path: known extension. Slow path: special basenames (Makefile…).
        if (indexableExts.has(ext) || detectLang(full) !== null) {
          results.push(full);
        }
      }
    }
  };

  await walk(projectRoot);
  return { files: results, complete, errors };
}

/**
 * Dispatch to the best available parser for `lang`.
 *
 * First-class AST/toolchain parsers run when available; every other language
 * (and native failures) land in the generic regex extractor so files always
 * contribute searchable symbols when they contain structure.
 */
async function parseFile(
  file: string,
  content: string,
  lang: string,
): Promise<ReturnType<typeof parseTs>> {
  const symbolLang = lang as SymbolLang;
  switch (symbolLang) {
    case 'ts':
    case 'tsx':
    case 'js':
    case 'jsx':
      return parseTs({ file, content, lang: symbolLang });
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
      // c, cpp, java, csharp, ruby, shell, md, … and 'other'
      return parseGeneric({ file, content, lang: symbolLang });
  }
}

function assignRefsToSymbols(refs: Ref[], symbols: IndexSymbol[]): Ref[] {
  if (refs.length === 0 || symbols.length === 0) return [];
  const ordered = [...symbols].sort((a, b) => a.line - b.line || a.col - b.col || a.id - b.id);
  const seen = new Set<string>();
  const assigned: Ref[] = [];
  for (const ref of refs) {
    let owner: IndexSymbol | undefined;
    for (const symbol of ordered) {
      if (symbol.line > ref.line) break;
      owner = symbol;
    }
    // Imports usually appear before the first declaration. Attach them to the
    // first real symbol so file/package dependency graphs retain the module
    // edge without inventing an invalid owner id 0.
    if (!owner && ref.callType === 'import') owner = ordered[0];
    if (!owner || owner.id <= 0) continue;
    const key = `${owner.id}:${ref.toName}:${ref.callType}`;
    if (seen.has(key)) continue;
    seen.add(key);
    assigned.push({ ...ref, fromId: owner.id });
  }
  return assigned;
}

/** Run a full or incremental index and return statistics. */
export async function runIndexer(_ctx: Context, opts: IndexerOptions): Promise<IndexResult> {
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
  const { projectRoot, langs, ignore = [], signal } = opts;
  // Graph semantics changed without a structural SQLite schema change. Keep a
  // separate data-version marker so older running processes do not downgrade
  // and wipe the same shared DB while a new WebUI is being rolled out.
  const relationGraphVersion = '2';
  const force =
    (opts.force ?? false) || store.getMetadata('relation_graph_version') !== relationGraphVersion;
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
  let discoveryComplete = true;
  if (opts.files && opts.files.length > 0) {
    // Explicit file list (per-edit / watcher path): keep paths inside the
    // project only and apply both always-on and .gitignore exclusions.
    files = opts.files
      .map((f) => path.resolve(projectRoot, f))
      .filter((f) => {
        if (!isWithinProject(projectRoot, f)) return false;
        const rel = path.relative(projectRoot, f).replace(/\\/g, '/');
        return (
          !rel.split('/').some((seg) => DEFAULT_IGNORE.includes(seg)) &&
          !DEFAULT_IGNORE_FILES.has(path.basename(f)) &&
          !isGitIgnored(rel, false)
        );
      });
  } else {
    const discovery = await findSourceFiles(projectRoot, ignore, isGitIgnored, signal);
    files = discovery.files;
    errors.push(...discovery.errors);
    discoveryComplete = discovery.complete;
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
  // Batch width follows WRONGSTACK_PERF_PROFILE (frugal ≤4, balanced cores×4).
  const parallelBatch = resolveParallelBatch();
  let filesSinceLastYield = 0;
  for (let batchStart = 0; batchStart < files.length; batchStart += parallelBatch) {
    const batchEnd = Math.min(batchStart + parallelBatch, files.length);
    const batchFiles = files.slice(batchStart, batchEnd);

    // Report progress to the caller so UIs can show indexing status.
    opts.onProgress?.(batchEnd, files.length);

    // Yield the event loop periodically so the main thread stays responsive
    // (TUI rendering, input handling, etc.) during large index builds.
    // Uses a running counter instead of batchStart % YIELD_EVERY_N which
    // only works when the batch size divides YIELD_EVERY_N evenly — with
    // dynamic batch sizes that invariant no longer holds and the yield would
    // fire far less often than intended.
    // Also check for cancellation — the tool executor's timeout or a
    // session abort propagates through `signal`.
    filesSinceLastYield += batchFiles.length;
    if (filesSinceLastYield >= YIELD_EVERY_N) {
      filesSinceLastYield = 0;
      await yieldEventLoop();
      // Frugal: brief pause so sustained reindex doesn't pin a core.
      if (isFrugalPerf()) {
        await new Promise<void>((r) => setTimeout(r, 8));
      }
      throwIfAborted(signal);
    }

    // Phase 1: Parallel stat + incremental skip + read + parse
    const statOpts = signal ? { signal } : {};
    const statReadParse = await Promise.allSettled(
      batchFiles.map(
        async (
          file,
        ): Promise<{
          file: string;
          stat: Stats;
          lang: string;
          parsed: Awaited<ReturnType<typeof parseFile>> | null;
          content?: string;
          skippedMeta?: FileMeta;
          error?: string;
          missing?: boolean;
        }> => {
          let stat: Stats;
          try {
            stat = await (
              fs.stat as (path: string, opts: { signal?: AbortSignal }) => Promise<Stats>
            )(file, statOpts);
          } catch (e) {
            if (isAbortError(e)) throw e;
            return {
              file,
              stat: null as never as Stats,
              lang: '',
              parsed: null,
              error: `stat error: ${e instanceof Error ? e.message : String(e)}`,
              missing: isMissingPathError(e),
            };
          }
          if (!stat.isFile()) return { file, stat, lang: '', parsed: null };

          const lang = detectLang(file);
          if (!lang) return { file, stat, lang: '', parsed: null };
          if (stat.size > MAX_INDEX_FILE_BYTES) {
            return {
              file,
              stat,
              lang,
              parsed: null,
              error: `file too large (${stat.size} bytes; max ${MAX_INDEX_FILE_BYTES})`,
            };
          }

          const meta = existingMeta.get(file);
          if (!force && meta && meta.mtimeMs === Math.floor(stat.mtimeMs)) {
            return { file, stat, lang, parsed: null, skippedMeta: meta };
          }

          let content: string;
          try {
            content = await fs.readFile(file, { encoding: 'utf8', signal });
          } catch (e) {
            if (isAbortError(e)) throw e;
            return {
              file,
              stat,
              lang,
              parsed: null,
              error: `read error: ${e instanceof Error ? e.message : String(e)}`,
            };
          }

          let parsed: Awaited<ReturnType<typeof parseFile>>;
          try {
            parsed = await parseFile(file, content, lang);
          } catch (e) {
            return {
              file,
              stat,
              lang,
              parsed: null,
              error: `parse error: ${e instanceof Error ? e.message : String(e)}`,
            };
          }
          return { file, stat, lang, parsed, content };
        },
      ),
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
        // A missing path in a targeted watcher/edit run is authoritative: the
        // source was deleted or renamed, so remove its previous index rows.
        // Read/parse/permission failures are transient and retain the last good
        // snapshot instead of replacing it with an empty one.
        if (result.missing) store.deleteFile(file);
        errors.push(`${file}: ${result.error}`);
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
      // know the mtime. Single transaction clears stale rows + upserts meta.
      if (parsed.symbols.length === 0) {
        store.replaceEmptyFile({
          file,
          lang: lang as SymbolLang,
          mtimeMs: Math.floor(stat.mtimeMs),
          symbolCount: 0,
          lastIndexed: Date.now(),
        });
        filesIndexed++;
        continue;
      }

      batchEntries.push({
        file,
        lang: lang as SymbolLang,
        symbols: parsed.symbols,
        refs: parsed.refs ?? [],
        mtimeMs: Math.floor(stat.mtimeMs),
        symbolCount: parsed.symbols.length,
      });
      deleteForFiles.push(file);
    }

    if (batchEntries.length > 0) {
      try {
        store.commitBatch(batchEntries, { deleteForFiles });
        for (const entry of batchEntries) {
          const count = entry.symbols.length;
          symbolsIndexed += count;
          langStats[entry.lang] = (langStats[entry.lang] ?? 0) + count;
          filesIndexed++;
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
              const fallbackBatch = assignRefsToSymbols(entry.refs, symbolsWithIds);
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
            errors.push(
              `fallback write failed: ${entry.file}: ${innerErr instanceof Error ? innerErr.message : String(innerErr)}`,
            );
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
  if (discoveredFiles && discoveryComplete) {
    for (const [file_] of existingMeta) {
      if (!discoveredFiles.has(file_)) {
        store.deleteFile(file_);
      }
    }
  }

  // Resolution must run even when every file was an incremental-cache hit:
  // older indexes can contain unresolved refs from a previous interrupted run.
  store.resolveRefs();
  store.setMetadata('relation_graph_version', relationGraphVersion);
  // Refresh query planner stats after bulk writes (best-effort, free on small DBs).
  store.optimize();

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
