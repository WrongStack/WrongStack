import { existsSync, readdirSync, statSync } from 'node:fs';
import { extname, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// File-collection helpers (shared across multiple plugin source-scan tools)
// ---------------------------------------------------------------------------

export interface CollectOptions {
  /** File extensions to include (e.g. ['.ts', '.tsx', '.js']). */
  extensions: string[];
  /** Directory names to skip entirely. Default skips node_modules, dist, .git, coverage. */
  excludeDirs?: string[] | undefined;
  /** Maximum recursion depth. Unlimited when omitted. */
  maxDepth?: number | undefined;
}

const DEFAULT_EXCLUDE_DIRS = ['node_modules', 'dist', '.git', 'coverage'];

/**
 * Recursively collect files under `root` whose extension is in
 * `opts.extensions`. Skips directories named in `opts.excludeDirs`
 * (defaulting to node_modules, dist, .git, coverage) and limits depth
 * when `opts.maxDepth` is set.
 *
 * Shared by 6+ plugin source-scan tools that previously duplicated
 * this implementation identically.
 *
 * Determinism: returns files in sorted order (locale-aware) so
 * scan results are reproducible across platforms and file systems.
 */
export function collectSourceFiles(root: string, opts: CollectOptions): string[] {
  const files: string[] = [];
  if (!existsSync(root)) return files;
  const resolvedRoot = resolve(root);
  let s;
  try {
    s = statSync(resolvedRoot);
  } catch {
    return files;
  }
  if (s.isFile()) {
    if (matchesExtension(resolvedRoot, opts.extensions)) files.push(resolvedRoot);
    return files;
  }
  if (!s.isDirectory()) return files;
  const exclude = opts.excludeDirs ?? DEFAULT_EXCLUDE_DIRS;
  const excludeSet = new Set(exclude); // O(1) lookup instead of O(n) includes()
  const visitedInodes = new Set<string>();
  if (s.dev !== undefined && s.ino !== undefined && (s.dev !== 0 || s.ino !== 0)) {
    visitedInodes.add(`${s.dev}:${s.ino}`);
  }

  function walk(dir: string, depth: number) {
    if (opts.maxDepth !== undefined && depth > opts.maxDepth) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    // Sort entries for deterministic traversal order across platforms.
    entries.sort((a, b) => a.localeCompare(b));
    for (const entry of entries) {
      if (excludeSet.has(entry)) continue;
      const full = resolve(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (st.dev !== undefined && st.ino !== undefined && (st.dev !== 0 || st.ino !== 0)) {
          const inodeKey = `${st.dev}:${st.ino}`;
          if (visitedInodes.has(inodeKey)) continue;
          visitedInodes.add(inodeKey);
        }
        walk(full, depth + 1);
      } else if (st.isFile() && matchesExtension(full, opts.extensions)) {
        files.push(full);
      }
    }
  }

  walk(resolvedRoot, 0);
  return files;
}

/**
 * Async version of `collectSourceFiles` for non-blocking file collection.
 * Uses `fs.promises` to avoid blocking the event loop on large directory trees.
 *
 * Performance: prefer this in hooks and tools that run on every write/edit
 * (e.g., duplicate-code-detector) to keep the agent loop responsive during
 * large scans.
 */
export async function collectSourceFilesAsync(
  root: string,
  opts: CollectOptions,
): Promise<string[]> {
  const { readdir, stat } = await import('node:fs/promises');
  const files: string[] = [];
  const resolvedRoot = resolve(root);

  try {
    const s = await stat(resolvedRoot);
    if (s.isFile()) {
      if (matchesExtension(resolvedRoot, opts.extensions)) files.push(resolvedRoot);
      return files;
    }
    if (!s.isDirectory()) return files;
  } catch {
    return files;
  }

  const exclude = opts.excludeDirs ?? DEFAULT_EXCLUDE_DIRS;
  const excludeSet = new Set(exclude);

  async function walk(dir: string, depth: number): Promise<void> {
    if (opts.maxDepth !== undefined && depth > opts.maxDepth) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name)); // deterministic order
    for (const entry of entries) {
      if (excludeSet.has(entry.name)) continue;
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (entry.isFile() && matchesExtension(full, opts.extensions)) {
        files.push(full);
      }
    }
  }

  await walk(resolvedRoot, 0);
  return files;
}

/**
 * Check whether `p` has one of the given extensions (case-insensitive).
 * Handles extensions with or without a leading dot and normalizes casing/whitespace.
 * Replaces a 6-copy helper that was duplicated identically across
 * source-scan plugins.
 */
export function matchesExtension(p: string, exts: string[]): boolean {
  const fileExt = extname(p).toLowerCase();
  if (!fileExt) return false;
  return exts.some((ext) => {
    if (!ext || typeof ext !== 'string') return false;
    const trimmed = ext.trim().toLowerCase();
    const normalized = trimmed.startsWith('.') ? trimmed : `.${trimmed}`;
    return normalized === fileExt;
  });
}
