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

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { Dirent, Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import * as path from 'node:path';
import type { Context } from '@wrongstack/core/agent';
import {
  DEFAULT_WALK_IGNORE_DIRS,
  indexParallelBatchSize,
  isFrugalPerf,
} from '@wrongstack/core/utils';
import { xxhash64String as contentHashHex } from './content-hash.js';
import { type IgnoreMatcher, loadGitignoreMatcher } from './gitignore.js';
import { detectLang, INDEXABLE_EXTENSIONS } from './languages.js';
import { ModuleResolver } from './module-resolver.js';
import { assignPackageLabels, detectModuleRoots } from './module-roots.js';
import { type parseFileContent, parseFilesContent } from './parser-dispatch.js';
import { getParserPool, resolveWorkerPoolThreshold } from './parser-worker-pool.js';
import type { FileMeta, IndexResult, Symbol as IndexSymbol, Ref, SymbolLang } from './schema.js';
import { IndexStore } from './writer.js';

// Phase 5 parser worker pool infrastructure lives in parser-worker-pool.ts and
// parser-worker-script.ts. The indexer integration (post-batch pool delegation)
// is deferred — see the comment at the parse call site below for why pool
// delegation cannot happen inside the Promise.allSettled callback.

/** Yield the event loop every N files so the main thread stays responsive. */
const YIELD_EVERY_N = 50;

/**
 * Parallel parse batch size — see {@link indexParallelBatchSize}.
 * Re-resolved at the start of each index run so env profile changes apply.
 */
export function resolveParallelBatch(): number {
  return indexParallelBatchSize(availableParallelism());
}

/**
 * Pool startup is amortized across the complete index run, not one outer
 * batch. Balanced batches are capped at 40 files, so comparing the per-batch
 * parse count with the 500-file threshold made the worker path unreachable.
 *
 * Threshold is env-configurable (audit T-04): `WRONGSTACK_INDEX_WORKER_THRESHOLD`
 * overrides the default, `0` disables the worker path entirely.
 */
export function shouldUseParserWorkerPool(
  candidateFileCount: number,
  parseBatchCount: number,
): boolean {
  const threshold = resolveWorkerPoolThreshold();
  // 0 = explicit opt-out: no candidate count (not even 0 itself, which would
  // satisfy >= 0) may take the worker path.
  if (threshold === 0) return false;
  return !isFrugalPerf() && candidateFileCount >= threshold && parseBatchCount > 1;
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
const INDEXABLE_EXTENSION_SET = new Set(INDEXABLE_EXTENSIONS);
const MAX_INDEX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_GIT_FILE_LIST_BYTES = 64 * 1024 * 1024;
const GIT_SNAPSHOT_METADATA_KEY = 'git_discovery_snapshot';

class IndexSourceChangedError extends Error {
  override name = 'IndexSourceChangedError';
}

function isWithinProject(projectRoot: string, file: string): boolean {
  const rel = path.relative(projectRoot, file);
  return rel !== '' && !rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel);
}

function isMissingPathError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function normalizeComparablePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function gitOutput(projectRoot: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', projectRoot, ...args],
      {
        encoding: 'buffer',
        maxBuffer: MAX_GIT_FILE_LIST_BYTES,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
      },
    );
  });
}

/**
 * Git already maintains the canonical tracked/untracked directory index. On a
 * repository root this avoids hundreds of serial `readdir` calls; non-Git
 * projects and nested roots fall back to the filesystem walker below.
 */
async function findGitSourceFiles(
  projectRoot: string,
  ignore: string[],
  signal?: AbortSignal | undefined,
): Promise<{ files: string[]; trustedUnchanged: Set<string>; snapshotKey: string } | null> {
  try {
    throwIfAborted(signal);
    const topLevel = (await gitOutput(projectRoot, ['rev-parse', '--show-toplevel']))
      .toString('utf8')
      .trim();
    if (normalizeComparablePath(topLevel) !== normalizeComparablePath(projectRoot)) return null;

    throwIfAborted(signal);
    const ignoreSet = new Set([...DEFAULT_IGNORE, ...ignore]);
    const [output, statusOutput, stagedOutput] = await Promise.all([
      gitOutput(projectRoot, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']),
      gitOutput(projectRoot, [
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
        '--ignored=no',
      ]),
      gitOutput(projectRoot, ['ls-files', '--stage', '-z']),
    ]);
    throwIfAborted(signal);
    const dirty = new Set<string>();
    const deleted = new Set<string>();
    const statusRecords = statusOutput.toString('utf8').split('\0');
    for (let i = 0; i < statusRecords.length; i++) {
      const record = statusRecords[i];
      if (!record) continue;
      const status = record.slice(0, 2);
      const changedPath = path.resolve(projectRoot, record.slice(3));
      dirty.add(changedPath);
      if (status.includes('D')) deleted.add(changedPath);
      if (status.includes('R') || status.includes('C')) {
        const source = statusRecords[++i];
        if (source) dirty.add(path.resolve(projectRoot, source));
      }
    }
    const files: string[] = [];
    for (const relative of output.toString('utf8').split('\0')) {
      if (!relative) continue;
      const portable = relative.replace(/\\/g, '/');
      if (
        portable.split('/').some((segment) => ignoreSet.has(segment)) ||
        DEFAULT_IGNORE_FILES.has(path.posix.basename(portable))
      ) {
        continue;
      }
      const full = path.resolve(projectRoot, relative);
      if (deleted.has(full)) continue;
      const ext = path.extname(relative).toLowerCase();
      if (INDEXABLE_EXTENSION_SET.has(ext) || detectLang(full) !== null) files.push(full);
    }
    const snapshot = createHash('sha256').update(stagedOutput).update('\0').update(statusOutput);
    const indexedFiles = new Set(files);
    for (const dirtyFile of [...dirty].sort()) {
      if (!indexedFiles.has(dirtyFile) || deleted.has(dirtyFile)) continue;
      snapshot.update('\0').update(dirtyFile).update('\0');
      snapshot.update(contentHashHex(await fs.readFile(dirtyFile, 'utf8')));
    }
    return {
      files,
      trustedUnchanged: new Set(files.filter((file) => !dirty.has(file))),
      snapshotKey: snapshot.digest('hex'),
    };
  } catch {
    return null;
  }
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
): Promise<{
  files: string[];
  complete: boolean;
  errors: string[];
  trustedUnchanged?: Set<string>;
  snapshotKey?: string;
}> {
  const gitFiles = await findGitSourceFiles(projectRoot, ignore, signal);
  if (gitFiles) {
    return {
      files: gitFiles.files,
      complete: true,
      errors: [],
      trustedUnchanged: gitFiles.trustedUnchanged,
      snapshotKey: gitFiles.snapshotKey,
    };
  }

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
    // The module is part of the identity: same-name imports from different
    // modules are distinct dependencies (mirrors ts-parser's deduplicateRefs).
    const key = `${owner.id}:${ref.toName}:${ref.callType}:${ref.module ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    assigned.push({ ...ref, fromId: owner.id });
  }
  return assigned;
}

/**
 * Post-index pass: derive the project's ecosystem structure, label every file
 * with its Code Atlas package, and resolve import specifiers to target files.
 *
 * This runs after indexing rather than during it for two reasons. Resolution
 * needs the *complete* file set — a file cannot resolve an import to a module
 * that has not been discovered yet — and the evidence it depends on (`go.mod`,
 * `Cargo.toml`, `package.json`) lives on disk, not in the database, so doing it
 * here is what allows the graph readers to stay purely SQL and language-blind.
 *
 * Failures are recorded and swallowed: a repo with an unreadable manifest still
 * gets a usable index, just with coarser grouping.
 */
async function resolveProjectRelations(
  store: IndexStore,
  projectRoot: string,
  opts: {
    onlyFiles?: readonly string[] | undefined;
    errors: string[];
    signal?: AbortSignal | undefined;
  },
): Promise<void> {
  // An aborted run skips the pass rather than throwing: the indexer's contract
  // is to return partial results with errors recorded, and turning a graceful
  // return into a rejection here would change that for every caller.
  if (opts.signal?.aborted) return;
  try {
    const indexedFiles = store.getAllFileMetas().map((meta) => meta.file);
    if (indexedFiles.length === 0) return;

    const structure = await detectModuleRoots(projectRoot, indexedFiles);
    if (opts.signal?.aborted) return;

    store.setFilePackages(assignPackageLabels(structure, indexedFiles));

    const resolver = new ModuleResolver(structure, indexedFiles, store.getNamespaceDeclarations());
    const pending = store.getUnresolvedImports(opts.onlyFiles);
    const resolutions: Array<{
      fromFile: string;
      lang: string;
      module: string;
      toFile: string;
    }> = [];
    for (const entry of pending) {
      const toFile = resolver.resolve(entry.fromFile, entry.lang as SymbolLang, entry.module);
      // Self-imports (a barrel re-exporting its own directory) are not edges.
      if (toFile && toFile !== entry.fromFile) {
        resolutions.push({ ...entry, toFile });
      }
    }
    if (opts.signal?.aborted) return;
    store.applyImportResolutions(resolutions);
  } catch (err) {
    opts.errors.push(`relation resolution: ${err instanceof Error ? err.message : String(err)}`);
  }
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

export async function runIndexerWithStore(
  store: IndexStore,
  opts: IndexerOptions,
): Promise<IndexResult> {
  let result: IndexResult;
  try {
    result = await store.runAtomicIndexUpdate(() => runIndexerAtomic(store, opts));
  } catch (error) {
    if (!(error instanceof IndexSourceChangedError)) throw error;
    // One bounded retry turns an edit that raced discovery into a coherent
    // generation. A second race fails and preserves the previous generation.
    result = await store.runAtomicIndexUpdate(() => runIndexerAtomic(store, opts));
  }
  // VACUUM cannot run inside a transaction. Publish the completed generation
  // first, then perform best-effort maintenance on full-project runs.
  if (!opts.files) store.compactIfNeeded();
  return result;
}

async function runIndexerAtomic(store: IndexStore, opts: IndexerOptions): Promise<IndexResult> {
  const { projectRoot, langs, ignore = [], signal } = opts;
  // Graph semantics changed without a structural SQLite schema change. Keep a
  // separate data-version marker so older running processes do not downgrade
  // and wipe the same shared DB while a new WebUI is being rolled out.
  const relationGraphVersion = '2';
  const refResolutionVersion = '2';
  const force =
    (opts.force ?? false) || store.getMetadata('relation_graph_version') !== relationGraphVersion;
  const needsFullRefResolution =
    force || store.getMetadata('ref_resolution_version') !== refResolutionVersion;
  const startMs = Date.now();
  const errors: string[] = [];
  const langStats: Record<string, number> = {};
  // P5.15: filesIndexed counts ONLY files parsed and committed with symbols
  // (mirrors filesParsed). Skips/empties live in fileOutcomes. Invariant:
  // exactly one counter (filesIndexed/filesParsed, filesSkipped, filesEmpty,
  // filesFailed) bumps per file outcome — filesIndexed is the parsed branch.
  let filesIndexed = 0;
  let filesParsed = 0;
  let filesSkipped = 0;
  let filesEmpty = 0;
  let filesFailed = 0;
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
  let trustedUnchanged: Set<string> | undefined;
  let discoverySnapshotKey: string | undefined;
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
    trustedUnchanged = discovery.trustedUnchanged;
    discoverySnapshotKey = discovery.snapshotKey;
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

  // A clean Git status only proves that disk matches this checkout. It says
  // nothing about whether the persisted DB was built from this checkout.
  // Enable the no-stat fast path only for the exact Git snapshot recorded by
  // the last completed full-project index.
  const snapshotTrusted =
    !force &&
    discoverySnapshotKey !== undefined &&
    store.getMetadata(GIT_SNAPSHOT_METADATA_KEY) === discoverySnapshotKey;
  if (!snapshotTrusted) trustedUnchanged = undefined;

  // Git has already checked clean tracked files while producing status. Fold
  // their stored counts into the result once, before the async batch loop,
  // instead of creating thousands of promises and scheduler yields merely to
  // rediscover that their mtimes did not change.
  const totalFilesForProgress = files.length;
  let filesPreSkipped = 0;
  if (!force && trustedUnchanged) {
    files = files.filter((file) => {
      const meta = existingMeta.get(file);
      if (!meta || !trustedUnchanged.has(file)) return true;
      langStats[meta.lang] = (langStats[meta.lang] ?? 0) + meta.symbolCount;
      symbolsIndexed += meta.symbolCount;
      // P5.15: skipped files no longer count toward filesIndexed — the
      // headline is files actually parsed this run (see fileOutcomes).
      filesSkipped++;
      filesPreSkipped++;
      return false;
    });
    if (filesPreSkipped > 0) opts.onProgress?.(filesPreSkipped, totalFilesForProgress);
  }

  // Process files in batches for parallel I/O and parsing.
  // SQLite writes remain sequential (they're synchronous and CPU-bound).
  // Batch width follows WRONGSTACK_PERF_PROFILE (frugal ≤4, balanced cores×4).
  const parallelBatch = resolveParallelBatch();
  const parserPoolCandidateCount = files.length;
  let filesSinceLastYield = 0;
  for (let batchStart = 0; batchStart < files.length; batchStart += parallelBatch) {
    const batchEnd = Math.min(batchStart + parallelBatch, files.length);
    const batchFiles = files.slice(batchStart, batchEnd);

    // Report progress to the caller so UIs can show indexing status.
    opts.onProgress?.(filesPreSkipped + batchEnd, totalFilesForProgress);

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
          parsed: Awaited<ReturnType<typeof parseFileContent>> | null;
          content?: string;
          contentHash?: string;
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

          // Phase 2: content-hash short-circuit. mtime can change without the
          // bytes changing (git checkout, touch, formatter that's a no-op).
          // When the content hash matches what's stored, skip the expensive
          // parse pass entirely — but still update mtime so the next run's
          // fast path (the mtime check above) hits again.
          //
          // Compute the hash once here — it's reused in the return object so
          // the batch-write path doesn't hash the same content a second time.
          // Skip the short-circuit when there's no stored hash yet (first
          // index of this file, or a legacy v4 DB that hasn't been populated).
          // Without this guard, an empty stored hash would match an empty
          // computed hash on every run, skipping parsing forever.
          const contentHash = contentHashHex(content);
          if (!force && meta && meta.contentHash && contentHash === meta.contentHash) {
            return {
              file,
              stat,
              lang,
              parsed: null,
              content,
              contentHash,
              skippedMeta: { ...meta, mtimeMs: Math.floor(stat.mtimeMs) },
            };
          }

          // Phase 5: Parsing is deferred to a post-batch pass to avoid
          // concurrent-mutation races inside Promise.allSettled callbacks.
          // The callback returns the read content; the main thread decides
          // whether to parse inline or delegate to the worker pool after all
          // stat+hash checks have settled.
          return { file, stat, lang, parsed: null, content, contentHash };
        },
      ),
    );

    // Phase 1.5: Post-batch parse pass. Files were stat+hash-checked and
    // content-read in the parallel pass above, but parsing was deferred to
    // avoid the concurrent-mutation race that an inline pool delegation
    // inside each Promise.allSettled callback would create. Here we collect
    // all files that need parsing, then either delegate to the worker pool
    // (when available and the batch is large enough) or parse inline — both
    // single-threaded, no race.
    const toParse: Array<{
      index: number;
      file: string;
      content: string;
      lang: SymbolLang;
    }> = [];
    for (let pi = 0; pi < statReadParse.length; pi++) {
      const s = statReadParse[pi]!;
      if (s.status !== 'fulfilled') continue;
      const r = s.value;
      if (r.error || r.skippedMeta || !r.lang || r.parsed) continue;
      if (r.content === undefined) continue;
      toParse.push({
        index: pi,
        file: batchFiles[pi]!,
        content: r.content,
        lang: r.lang as SymbolLang,
      });
    }

    if (toParse.length > 0) {
      // Try the worker pool for large batches (Phase 5 — threshold-gated).
      // Falls back to inline parsing when the pool isn't available or the
      // batch is too small to justify spawn overhead. Activation is based on
      // files-to-parse count, not total file count, so stat-skipped batches
      // don't waste pool overhead on a tiny workload.
      let pool = shouldUseParserWorkerPool(parserPoolCandidateCount, toParse.length)
        ? getParserPool()
        : null;
      if (pool) {
        try {
          await pool.ensureReady();
          const parsedResults = await pool.parseFiles(
            toParse.map((p) => ({ file: p.file, content: p.content, lang: p.lang })),
          );
          // Match by file path — pool results arrive in completion order
          // (worker N may finish before worker M), not positional alignment.
          // Files that errored inside a worker are absent from parsedResults;
          // record them as parse errors so the commit loop doesn't silently
          // index them with zero symbols.
          const byFile = new Map(parsedResults.map((r) => [r.file, r]));
          for (const item of toParse) {
            const parsed = byFile.get(item.file);
            const settled = statReadParse[item.index]!;
            if (settled.status !== 'fulfilled') continue;
            if (parsed) {
              settled.value.parsed = parsed;
            } else {
              settled.value.error = `parse error: worker returned no result for ${item.file}`;
            }
          }
        } catch {
          // Pool failure — fall through to inline parsing for all files.
          pool = null;
        }
      }

      // Inline fallback (or when pool wasn't available). Parse in parallel
      // — this is the same parallelism the pre-refactor code had via the
      // single Promise.allSettled callback. Sequential parsing would
      // regress incremental indexing latency. P3.8: one call for the whole
      // slice, so Go/Python files inside it share one toolchain child
      // process per chunk instead of one spawn per file.
      if (!pool) {
        const parsedAll = await parseFilesContent(
          toParse.map((p) => ({ file: p.file, content: p.content, lang: p.lang })),
        );
        for (let pi2 = 0; pi2 < parsedAll.length && pi2 < toParse.length; pi2++) {
          const settled = statReadParse[toParse[pi2]!.index]!;
          if (settled.status !== 'fulfilled') continue;
          const slot = parsedAll[pi2]!;
          if (slot.result) {
            settled.value.parsed = slot.result;
          } else {
            // A throwing parser no longer aborts the run — parseFilesContent
            // contains it and carries the message (P3.8 fix; P2.5 surfaces it).
            settled.value.error = `parse error: ${slot.error ?? `no result for ${toParse[pi2]!.file}`}`;
          }
        }
      }
    }

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
        filesFailed++;
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
        filesFailed++;
        continue;
      }

      const { stat, lang, parsed } = result;
      if (result.skippedMeta) {
        langStats[lang] = (langStats[lang] ?? 0) + result.skippedMeta.symbolCount;
        symbolsIndexed += result.skippedMeta.symbolCount;
        // P5.15: content-hash skips don't count toward filesIndexed.
        filesSkipped++;
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
          store.upsertFile({
            file,
            lang: lang as SymbolLang,
            mtimeMs: Math.floor(stat.mtimeMs),
            symbolCount: 0,
            lastIndexed: Date.now(),
            contentHash: result.contentHash ?? '',
          });
          // P5.15: empty files don't count toward filesIndexed.
          filesEmpty++;
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
          contentHash: result.contentHash ?? '',
        });
        // P5.15: empty files don't count toward filesIndexed.
        filesEmpty++;
        continue;
      }

      batchEntries.push({
        file,
        lang: lang as SymbolLang,
        symbols: parsed.symbols,
        refs: parsed.refs ?? [],
        mtimeMs: Math.floor(stat.mtimeMs),
        symbolCount: parsed.symbols.length,
        contentHash: result.contentHash ?? '',
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
          filesParsed++;
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
            filesParsed++;
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
            filesFailed++;
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

  // Batch commits resolve only names touched by that batch. Existing databases
  // get one global repair pass when this contract version changes; subsequent
  // single-file watcher runs avoid rebuilding the full symbol-name map.
  if (needsFullRefResolution) store.resolveRefs();
  await resolveProjectRelations(store, projectRoot, {
    // A watcher run re-resolves only what it touched; a full run (or a contract
    // bump) re-resolves everything, because a newly indexed file can be the
    // target of imports written long before it.
    onlyFiles: needsFullRefResolution ? undefined : opts.files,
    errors,
    signal,
  });
  store.setMetadata('ref_resolution_version', refResolutionVersion);
  store.setMetadata('relation_graph_version', relationGraphVersion);
  const completeProjectScope =
    !opts.files && (!langs || langs.length === 0) && (!opts.ignore || opts.ignore.length === 0);
  if (completeProjectScope && discoverySnapshotKey !== undefined) {
    const finalSnapshot = await findGitSourceFiles(projectRoot, ignore, signal);
    if (!finalSnapshot || finalSnapshot.snapshotKey !== discoverySnapshotKey) {
      throw new IndexSourceChangedError(
        'Project files changed during indexing; retrying before publishing the generation.',
      );
    }
    // Do not bless a snapshot that carried any read/parse/relation failure.
    // The next run must validate content again instead of fast-skipping it.
    store.setMetadata(GIT_SNAPSHOT_METADATA_KEY, errors.length === 0 ? discoverySnapshotKey : '');
  }
  // Planner refresh belongs to full/bulk runs, not the edit watcher hot path.
  // P5.15: gate on actual work (parsed files), not the inflated legacy count.
  if (!opts.files || filesIndexed >= 50) store.optimize();

  store.setLastIndexed(Date.now());
  const durationMs = Date.now() - startMs;

  return {
    filesIndexed,
    fileOutcomes: {
      parsed: filesParsed,
      skipped: filesSkipped,
      empty: filesEmpty,
      failed: filesFailed,
    },
    symbolsIndexed,
    langStats,
    durationMs,
    errors,
  };
}
