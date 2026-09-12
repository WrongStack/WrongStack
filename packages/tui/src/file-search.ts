import type { Dirent } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.turbo',
  '.cache',
  'coverage',
  '.idea',
  '.vscode',
]);

const MAX_FILES_INDEXED = 5000;
const MAX_DEPTH = 8;

let cache: { root: string; files: string[]; loadedAt: number } | null = null;
const CACHE_TTL_MS = 30_000;

async function loadIndex(root: string): Promise<string[]> {
  const now = Date.now();
  if (cache && cache.root === root && now - cache.loadedAt < CACHE_TTL_MS) {
    return cache.files;
  }
  const files: string[] = [];
  await walk(root, '', 0, files);
  files.sort();
  cache = { root, files, loadedAt: now };
  return files;
}

async function walk(root: string, rel: string, depth: number, out: string[]): Promise<void> {
  if (out.length >= MAX_FILES_INDEXED) return;
  if (depth > MAX_DEPTH) return;
  const dir = rel ? path.join(root, rel) : root;
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= MAX_FILES_INDEXED) return;
    if (e.name.startsWith('.') && e.name !== '.env.example') continue;
    if (IGNORED_DIRS.has(e.name)) continue;
    const next = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      await walk(root, next, depth + 1, out);
    } else if (e.isFile()) {
      out.push(next);
    }
  }
}

/**
 * Subsequence (fuzzy) match — each character of `query` must appear in `s`
 * in order. Lower scores rank earlier. Score combines:
 *   - shorter match span (chars close together = better)
 *   - earlier first-match offset
 *   - shorter total path length
 */
function score(s: string, query: string): number | null {
  if (!query) return s.length;
  // Index paths always use `/` (see walk()). Treat `\` as the same separator
  // so `@src\foo` on Windows matches `src/foo.ts`.
  const ql = query.toLowerCase().replaceAll('\\', '/');
  const sl = s.toLowerCase();
  let si = 0;
  let firstHit = -1;
  let lastHit = -1;
  for (let qi = 0; qi < ql.length; qi++) {
    const c = ql.charCodeAt(qi);
    while (si < sl.length && sl.charCodeAt(si) !== c) si++;
    if (si >= sl.length) return null;
    if (firstHit < 0) firstHit = si;
    lastHit = si;
    si++;
  }
  const span = lastHit - firstHit;
  return span * 100 + firstHit * 2 + s.length;
}

export async function searchFiles(root: string, query: string, limit = 8): Promise<string[]> {
  const all = await loadIndex(root);
  if (!query) return all.slice(0, limit);
  const scored: { path: string; score: number }[] = [];
  for (const f of all) {
    const sc = score(f, query);
    if (sc !== null) scored.push({ path: f, score: sc });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, limit).map((x) => x.path);
}

export function invalidateFileCache(): void {
  cache = null;
}
