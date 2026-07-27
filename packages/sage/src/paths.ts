import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SagePaths } from './types.js';

export const DEFAULT_SAGE_DIR = '.wrongstack/memories';

export function resolveSagePaths(projectRoot: string, directory = DEFAULT_SAGE_DIR): SagePaths {
  if (path.isAbsolute(directory)) {
    throw new Error('SAGE directory must be project-relative.');
  }
  const resolvedProjectRoot = path.resolve(projectRoot);
  const rootDir = path.resolve(resolvedProjectRoot, directory);
  const relative = path.relative(resolvedProjectRoot, rootDir);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('SAGE directory must stay inside the project root.');
  }
  return {
    rootDir,
    manifest: path.join(rootDir, 'manifest.json'),
    memoriesLog: path.join(rootDir, 'memories.jsonl'),
    candidatesLog: path.join(rootDir, 'candidates.jsonl'),
    auditLog: path.join(rootDir, 'audit.jsonl'),
    graphDir: path.join(rootDir, 'graph'),
    edgesLog: path.join(rootDir, 'graph', 'edges.jsonl'),
    indexesDir: path.join(rootDir, 'indexes'),
    snapshotsDir: path.join(rootDir, 'snapshots'),
    hygieneDir: path.join(rootDir, 'hygiene'),
    tmpDir: path.join(rootDir, 'tmp'),
    locksDir: path.join(rootDir, 'locks'),
  };
}

/**
 * Cache of realpath() lookups for normalizeProjectPath. Without this,
 * every anchor normalize call would stat the filesystem — anchor
 * resolution runs on every remember / retrieveForPath invocation, so the
 * cache keeps the cost bounded by the number of unique paths instead
 * of the number of calls. Process-local: cross-process correctness is
 * not affected (every process resolves its own tree at startup).
 *
 * Hard cap: a long-lived project server that sees many ephemeral paths
 * (temp files, generated fixtures) must not grow this map unbounded.
 * Map insertion order gives cheap FIFO eviction of the oldest entry.
 */
const REALPATH_CACHE_MAX = 4_096;
const realpathCache = new Map<string, string>();
function cachedRealpath(p: string): string {
  const cached = realpathCache.get(p);
  if (cached !== undefined) {
    // Refresh LRU order so hot roots stay resident under eviction pressure.
    realpathCache.delete(p);
    realpathCache.set(p, cached);
    return cached;
  }
  // The nlink check distinguishes real files/dirs from the rest of the
  // filesystem, but for our purposes a single fs.realpathSync (which
  // throws on broken links) is sufficient — callers pass already-
  // resolved or relative paths that they expect to exist inside the
  // project root. Silent fallback to path.resolve() when the target
  // does not exist (e.g. creating a brand-new anchor for a file the
  // user is about to write) keeps the function total — anchors are
  // intentionally allowed to point at not-yet-existing paths.
  let resolved: string;
  try {
    resolved = fs.realpathSync(p);
  } catch {
    resolved = path.resolve(p);
  }
  while (realpathCache.size >= REALPATH_CACHE_MAX) {
    const oldest = realpathCache.keys().next().value;
    if (oldest === undefined) break;
    realpathCache.delete(oldest);
  }
  realpathCache.set(p, resolved);
  return resolved;
}

/**
 * Reset the realpath cache. Tests that change the underlying filesystem
 * (create / remove symlinks) call this to avoid stale entries.
 */
export function clearProjectPathCache(): void {
  realpathCache.clear();
}

export function normalizeProjectPath(projectRoot: string, inputPath: string): string {
  const root = cachedRealpath(path.resolve(projectRoot));
  const rawAbs = path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(root, inputPath);
  // Resolve the parent directory's symlinks so a directory inside the
  // project pointing outside is caught. Then resolve the leaf itself:
  // if the leaf is a symlink, realpathSync reveals its true target —
  // which may escape the project. The caller-facing basename is then
  // preserved by re-attaching it (or the realpath target basename if
  // it differs) to the realpath'd parent.
  const parentDir = path.dirname(rawAbs);
  const callerBasename = path.basename(rawAbs);
  let realParent: string;
  try {
    realParent = fs.realpathSync(parentDir);
  } catch {
    // Parent doesn't exist yet (e.g. a not-yet-created directory).
    // Fall back to plain resolve so the function stays total.
    realParent = path.resolve(parentDir);
  }
  // Now resolve the full leaf path to catch symlink escapes. The
  // escape check uses the resolved path; the return value preserves
  // the caller's literal basename so anchor identity keys (downstream
  // lookup, audit log, dedup) match what the caller typed.
  let abs: string;
  try {
    const realFull = fs.realpathSync(rawAbs);
    // Use the resolved leaf's parent for the containment check (the
    // escape vector is when the parent of the resolved path sits
    // outside the project root). If the resolved leaf is outside, the
    // path.join below will produce an abs that escapes, and the
    // startsWith('..') guard catches it.
    abs = path.join(path.dirname(realFull), callerBasename);
  } catch {
    // Leaf doesn't exist — anchor for a future file. Fall back to the
    // realpath'd parent + caller's basename.
    abs = path.join(realParent, callerBasename);
  }
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Memory path must stay inside the project root: ${inputPath}`);
  }
  return normalizeSlashes(rel || '.');
}

export function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+/g, '/');
}

export function ancestorPaths(projectPath: string): string[] {
  const normalized = normalizeSlashes(projectPath);
  if (normalized === '.') return ['.'];
  const parts = normalized.split('/').filter(Boolean);
  const result: string[] = [];
  for (let i = parts.length; i >= 1; i--) {
    result.push(parts.slice(0, i).join('/'));
  }
  return result;
}
