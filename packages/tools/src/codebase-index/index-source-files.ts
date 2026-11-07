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
import * as path from 'node:path';
import { DEFAULT_WALK_IGNORE_DIRS } from '@wrongstack/core/utils';
import { gitIsolationEnv } from '@wrongstack/primitives';
import { xxhash64String as contentHashHex } from './content-hash.js';
import type { IgnoreMatcher } from './gitignore.js';
import { throwIfAborted, YIELD_EVERY_N, yieldEventLoop } from './index-scheduling.js';
import { detectLang, INDEXABLE_EXTENSIONS } from './languages.js';
import type { IndexStore } from './writer.js';

export const DEFAULT_IGNORE = DEFAULT_WALK_IGNORE_DIRS;
export const DEFAULT_IGNORE_FILES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'pnpm-lock.yml',
]);

/**
 * The atlas projection, which is derived FROM this index.
 *
 * Indexing it makes the index describe its own output: every `--write` changes
 * three files, the next index run picks them up, and the freshness check then
 * reports drift caused by nothing but writing the atlas. It is a committed
 * artifact rather than source, and it carries no symbols worth searching.
 */
const ATLAS_PROJECTION_PREFIX = '.wrongstack/atlas/';

/** True for a project-relative posix path inside the atlas projection. */
export function isAtlasProjection(relativePosixPath: string): boolean {
  return relativePosixPath.startsWith(ATLAS_PROJECTION_PREFIX);
}
const INDEXABLE_EXTENSION_SET = new Set(INDEXABLE_EXTENSIONS);
export const MAX_INDEX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_GIT_FILE_LIST_BYTES = 64 * 1024 * 1024;

/**
 * The value stored in `files.git_blob`: the staged blob a row was built from,
 * bound to the content hash of that row. Binding the two means a writer that
 * rewrites the row without knowing about the column — an older build sharing
 * the database — changes the hash and so voids the trust by itself.
 */
export function gitBlobStamp(blob: string, contentHash: string | undefined): string {
  return contentHash ? `${blob}:${contentHash}` : '';
}

export function isWithinProject(projectRoot: string, file: string): boolean {
  const rel = path.relative(projectRoot, file);
  return rel !== '' && !rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel);
}

export function isMissingPathError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function normalizeComparablePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * `ls-files -m` re-reads working-tree files, which runs the programs the
 * repository's own config names (fsmonitor, `.gitattributes` filters); they
 * are switched off, and when that is not possible git does not run.
 */
async function gitOutput(projectRoot: string, args: string[]): Promise<Buffer> {
  // `rev-parse` reads no working-tree file; it skips the extra config spawn.
  const isolation = args[0] === 'rev-parse' ? {} : await gitIsolationEnv(projectRoot);
  if (!isolation)
    throw new Error('git isolation unavailable: the repository config could not be read');
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', projectRoot, ...args],
      {
        encoding: 'buffer',
        env: { ...process.env, ...isolation },
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
 * `git rev-parse --show-toplevel` per project root. A repository's top level
 * does not move under a running process, and on Windows every git spawn costs
 * a few hundred milliseconds — this one ran twice per full index run. Only a
 * success is remembered: a directory that is not a repository yet may become
 * one (`git init`), and must then stop taking the filesystem-walk fallback.
 */
const gitTopLevelCache = new Map<string, string>();

async function gitTopLevel(projectRoot: string): Promise<string> {
  const cached = gitTopLevelCache.get(projectRoot);
  if (cached !== undefined) return cached;
  const topLevel = (await gitOutput(projectRoot, ['rev-parse', '--show-toplevel']))
    .toString('utf8')
    .trim();
  gitTopLevelCache.set(projectRoot, topLevel);
  return topLevel;
}

/**
 * One `git ls-files` listing that carries everything discovery needs:
 * `-s` prints every tracked path with its staged mode and blob id, `-t` tags
 * each line, and `-m -d -o` add a tagged line for every path whose working
 * copy differs from the index (`C`), is gone (`R`), or is untracked (`?`).
 *
 * It replaces three processes (`ls-files --cached --others`, `status`,
 * `ls-files --stage`). On Windows each git spawn blocks the event loop for a
 * few hundred milliseconds inside `CreateProcess`, and the daemon serves every
 * client from that loop — the spawns were most of a full run over an unchanged
 * checkout. It also skips the index-vs-HEAD comparison `status` performs: a
 * staged change is already visible here through its blob id.
 */
const GIT_WORKTREE_ARGS = ['ls-files', '-z', '-t', '-s', '-m', '-d', '-o', '--exclude-standard'];

interface GitWorktree {
  /** Every path the listing names, tracked or untracked, project-relative. */
  paths: string[];
  /** Absolute paths whose working copy may differ from the index. */
  dirty: Set<string>;
  /** Absolute paths tracked in the index but missing from the working tree. */
  deleted: Set<string>;
  /** Staged blob id of every tracked path, absolute path keyed. */
  blobs: Map<string, string>;
}

function parseGitWorktree(projectRoot: string, output: Buffer): GitWorktree {
  const seen = new Set<string>();
  const paths: string[] = [];
  const dirty = new Set<string>();
  const deleted = new Set<string>();
  const blobs = new Map<string, string>();
  for (const record of output.toString('utf8').split('\0')) {
    if (record.length < 3) continue;
    const tag = record[0];
    // `? path` for untracked; `<tag> <mode> <blob> <stage>\t<path>` otherwise.
    const tab = tag === '?' ? -1 : record.indexOf('\t');
    const relative = tag === '?' ? record.slice(2) : tab === -1 ? '' : record.slice(tab + 1);
    if (!relative) continue;
    if (!seen.has(relative)) {
      seen.add(relative);
      paths.push(relative);
    }
    const full = path.resolve(projectRoot, relative);
    // H = unchanged in the working tree. Everything else — changed, removed,
    // untracked, unmerged, skip-worktree — is content git has not vouched for.
    if (tag === 'H') {
      const blob = record.slice(2, tab).split(' ')[1];
      if (blob) blobs.set(full, blob);
      continue;
    }
    dirty.add(full);
    if (tag === 'R') deleted.add(full);
  }
  // A removed path is listed as H, R and C; it is not a file to index.
  return {
    paths: paths.filter((p) => !deleted.has(path.resolve(projectRoot, p))),
    dirty,
    deleted,
    blobs,
  };
}

/**
 * Hash the checkout state an index generation is built from: the listing
 * (staged blob ids plus the dirty tags) and the bytes of every dirty indexed
 * file. Returns the content hash computed for each dirty file so the indexer
 * can compare it with the stored one instead of reading the file again.
 */
async function computeSnapshot(
  listing: Buffer,
  worktree: GitWorktree,
  indexedFiles: ReadonlySet<string>,
): Promise<{ snapshotKey: string; dirtyHashes: Map<string, string> }> {
  const snapshot = createHash('sha256').update('ls-files-v2\0').update(listing);
  const dirtyHashes = new Map<string, string>();
  for (const dirtyFile of [...worktree.dirty].sort()) {
    if (!indexedFiles.has(dirtyFile) || worktree.deleted.has(dirtyFile)) continue;
    const hash = contentHashHex(await fs.readFile(dirtyFile, 'utf8'));
    dirtyHashes.set(dirtyFile, hash);
    snapshot.update('\0').update(dirtyFile).update('\0');
    snapshot.update(hash);
  }
  return { snapshotKey: snapshot.digest('hex'), dirtyHashes };
}

/**
 * The staged blob of every file in `files` that Git reports clean right now, for the
 * end-of-run check that a stamp's own file did not move while the run read it. One
 * listing, no file reads; null when Git cannot answer (then nothing new is vouched for).
 */
export async function currentCleanBlobs(
  projectRoot: string,
  files: ReadonlySet<string>,
  signal?: AbortSignal | undefined,
): Promise<Map<string, string> | null> {
  try {
    throwIfAborted(signal);
    const listing = await gitOutput(projectRoot, GIT_WORKTREE_ARGS);
    throwIfAborted(signal);
    const worktree = parseGitWorktree(projectRoot, listing);
    const clean = new Map<string, string>();
    for (const file of files) {
      const blob = worktree.blobs.get(file);
      if (blob !== undefined && !worktree.dirty.has(file)) clean.set(file, blob);
    }
    return clean;
  } catch {
    return null;
  }
}

/**
 * Git already maintains the canonical tracked/untracked directory index. On a
 * repository root this avoids hundreds of serial `readdir` calls; non-Git
 * projects and nested roots fall back to the filesystem walker below.
 */
export async function findGitSourceFiles(
  projectRoot: string,
  ignore: string[],
  signal?: AbortSignal | undefined,
  isGitIgnored?: IgnoreMatcher,
): Promise<{
  files: string[];
  cleanBlobs: Map<string, string>;
  snapshotKey: string;
  dirtyHashes: Map<string, string>;
} | null> {
  try {
    throwIfAborted(signal);
    const topLevel = await gitTopLevel(projectRoot);
    if (normalizeComparablePath(topLevel) !== normalizeComparablePath(projectRoot)) return null;

    throwIfAborted(signal);
    const ignoreSet = new Set([...DEFAULT_IGNORE, ...ignore]);
    const listing = await gitOutput(projectRoot, GIT_WORKTREE_ARGS);
    throwIfAborted(signal);
    const worktree = parseGitWorktree(projectRoot, listing);
    const files: string[] = [];
    for (const relative of worktree.paths) {
      const portable = relative.replace(/\\/g, '/');
      if (
        portable.split('/').some((segment) => ignoreSet.has(segment)) ||
        DEFAULT_IGNORE_FILES.has(path.posix.basename(portable)) ||
        isAtlasProjection(portable) ||
        (isGitIgnored?.(portable, false) ?? false)
      ) {
        continue;
      }
      const full = path.resolve(projectRoot, relative);
      const ext = path.extname(relative).toLowerCase();
      if (INDEXABLE_EXTENSION_SET.has(ext) || detectLang(full) !== null) files.push(full);
    }
    const { snapshotKey, dirtyHashes } = await computeSnapshot(listing, worktree, new Set(files));
    // Clean = the working copy equals its staged blob. A path can carry both
    // an H line and a C line; only the H-only ones are vouched for.
    const cleanBlobs = new Map<string, string>();
    for (const file of files) {
      const blob = worktree.blobs.get(file);
      if (blob !== undefined && !worktree.dirty.has(file)) cleanBlobs.set(file, blob);
    }
    return { files, cleanBlobs, snapshotKey, dirtyHashes };
  } catch {
    return null;
  }
}

/**
 * Expand the directories in a targeted file list.
 *
 * A directory deleted or renamed outside the agent reaches the watcher as ONE
 * event naming the directory. A targeted run used to stat that path, find a
 * directory (skipped: not a file) or nothing (`deleteFile(dir)` matched no
 * row), and leave every file under it indexed — search and the call graph
 * kept answering from deleted sources, and the renamed copies were never
 * indexed. A non-indexable path is therefore replaced by the indexed files
 * under it (vanished ones are then removed as missing) plus the indexable
 * files now on disk there. Indexable file paths pass through untouched, so
 * the per-edit hot path never reads the file table.
 */
export async function expandTargetedDirectories(
  store: IndexStore,
  projectRoot: string,
  targets: string[],
  isGitIgnored: IgnoreMatcher,
  signal: AbortSignal | undefined,
): Promise<string[]> {
  const isIndexableName = (file: string) =>
    INDEXABLE_EXTENSION_SET.has(path.extname(file).toLowerCase()) || detectLang(file) !== null;
  const expanded = new Set<string>();
  let indexedFiles: string[] | undefined;
  for (const target of targets) {
    if (isIndexableName(target) || !isWithinProject(projectRoot, target)) {
      expanded.add(target);
      continue;
    }
    let stats: Stats | undefined;
    try {
      stats = await fs.stat(target);
    } catch (err) {
      if (!isMissingPathError(err)) {
        expanded.add(target);
        continue;
      }
    }
    if (stats && !stats.isDirectory()) {
      expanded.add(target);
      continue;
    }
    indexedFiles ??= store.getAllFileMetas().map((meta) => meta.file);
    const prefix = normalizeComparablePath(target) + path.sep;
    for (const file of indexedFiles) {
      if (normalizeComparablePath(file).startsWith(prefix)) expanded.add(file);
    }
    if (!stats) continue;
    const walk = async (dir: string): Promise<void> => {
      throwIfAborted(signal);
      let entries: Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (DEFAULT_IGNORE.includes(entry.name)) continue;
        const full = path.join(dir, entry.name);
        const rel = path.relative(projectRoot, full).replace(/\\/g, '/');
        if (entry.isDirectory()) {
          if (!isGitIgnored(rel, true)) await walk(full);
        } else if (entry.isFile() && isIndexableName(full)) {
          expanded.add(full);
        }
      }
    };
    await walk(target);
  }
  return [...expanded];
}

export async function findSourceFiles(
  projectRoot: string,
  ignore: string[],
  isGitIgnored: IgnoreMatcher,
  signal?: AbortSignal | undefined,
): Promise<{
  files: string[];
  complete: boolean;
  errors: string[];
  /**
   * Staged blob id of every file whose working copy Git reports unchanged —
   * the per-file trust evidence checked against `files.git_blob`.
   */
  cleanBlobs?: Map<string, string>;
  /** Fingerprint of the checkout, compared again at the end of the run. */
  snapshotKey?: string;
  /** Content hash of each dirty indexed file, computed for the snapshot. */
  dirtyHashes?: Map<string, string>;
}> {
  const gitFiles = await findGitSourceFiles(projectRoot, ignore, signal, isGitIgnored);
  if (gitFiles) {
    return {
      files: gitFiles.files,
      complete: true,
      errors: [],
      cleanBlobs: gitFiles.cleanBlobs,
      snapshotKey: gitFiles.snapshotKey,
      dirtyHashes: gitFiles.dirtyHashes,
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
        if (isAtlasProjection(rel)) continue;
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
