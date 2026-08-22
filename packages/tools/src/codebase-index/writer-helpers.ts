import { resolveWstackPaths } from '@wrongstack/core/utils';
import type { Symbol as IndexSymbol, Ref } from './schema.js';

export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

// ─── P4.12: fixed placeholder buckets ────────────────────────────────────────
//
// IndexStore's statement cache is an LRU keyed by the SQL string, so every
// distinct placeholder count is a distinct key — a fresh prepare and an
// eviction. Chunked writes with `slice(i, i + n)` produce a different final
// chunk length on nearly every batch, which used to churn the cache
// constantly. Both helpers below draw chunk/in-list sizes from a powers-of-
// two ladder so a given statement shape resolves to at most log2(max)+1
// distinct SQL strings that stay resident.

/**
 * Split `total` into chunk sizes drawn from a powers-of-two ladder (each ≤
 * `max`), largest first. Example: total=1000, max=450 → [256, 256, 256, 128,
 * 64, 32, 8]. Distinct sizes ≤ log2(max)+1, so the same INSERT statement
 * re-prepares at most ~9 times ever — after that every chunk size is a cache
 * hit. INSERT VALUES rows cannot be padded (padding would insert garbage
 * rows), so variable-size chunks are the only option there — this makes the
 * variability bounded and tiny.
 */
export function ladderChunkSizes(total: number, max: number): number[] {
  if (total <= 0) return [];
  const sizes: number[] = [];
  let remaining = total;
  while (remaining > 0) {
    const cap = Math.min(remaining, max);
    const pow = cap >= 1 ? 2 ** Math.floor(Math.log2(cap)) : 1;
    const take = Math.max(1, Math.min(pow, remaining));
    sizes.push(take);
    remaining -= take;
  }
  return sizes;
}

/** Largest power of two ≥ count (unbounded — callers cap their own chunks). */
function nextPow2(count: number): number {
  return count <= 1 ? 1 : 2 ** Math.ceil(Math.log2(count));
}

/**
 * Pad `values` up to the next power-of-two length by repeating `values[0]`,
 * for single-statement IN-lists whose size is caller-determined (not chunked
 * by us). Safe because IN is set semantics: `x IN (a, a, b)` ≡ `x IN (a, b)`.
 * The bind overhead is at most ~2×, and every list length maps to one of
 * ~10 SQL strings instead of one per distinct count.
 */
export function padToInBucket<T>(values: readonly T[]): T[] {
  if (values.length <= 1) return values.slice();
  const target = nextPow2(values.length);
  const padded = values.slice();
  while (padded.length < target) padded.push(padded[0]!);
  return padded;
}

/** Placeholder string with `count` bind markers — `count` should be a bucket. */
export function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(',');
}

/**
 * Chunk plan for IN-list sites (the pad-able counterpart to
 * {@link ladderChunkSizes}). When the whole list fits under `max`, it is ONE
 * chunk — a single statement, exactly like the pre-P4.12 code — and SQL-string
 * stability comes from {@link padToInBucket} instead. Only a list that exceeds
 * `max` is ladder-split, with the ladder capped at the largest power of two ≤
 * max so chunks are already bucket sizes (padding is a no-op on them) and
 * can never pad past the variable budget.
 */
export function inListChunks(total: number, max: number): number[] {
  if (total <= 0) return [];
  // Fast path ONLY when the padded bucket also fits: padToInBucket rounds up
  // to the next power of two, so a 513-item list under a 900 cap would pad
  // to 1024 placeholders — past SQLITE_MAX_VARIABLE_NUMBER. The fast-path
  // guard must therefore test the bucket, not the raw count.
  if (nextPow2(total) <= max) return [total];
  const powMax = Math.max(1, 2 ** Math.floor(Math.log2(max)));
  return ladderChunkSizes(total, powMax);
}

/** Normalize an indexed or user-supplied file path for comparison. */
export function posixIndexPath(file: string): string {
  return file.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * SQL predicate that matches a stored `file` column against a user-supplied
 * path. Agents pass project-relative paths (`src/calc.ts`); the index stores
 * absolute OS paths. Exact, slash-normalized, and suffix matches are accepted.
 */
export function indexedFileMatchSql(column = 'file'): string {
  return (
    `(${column} = ?` +
    ` OR replace(${column}, '\\', '/') = ?` +
    ` OR replace(${column}, '\\', '/') LIKE ? ESCAPE '\\')`
  );
}

/** Bind values for {@link indexedFileMatchSql}: exact, posix, suffix-LIKE. */
export function indexedFileMatchArgs(file: string): [string, string, string] {
  const posix = posixIndexPath(file.trim());
  return [file, posix, `%/${escapeLike(posix)}`];
}

/** True when a stored file path belongs to a package name or path fragment. */
export function matchesIndexedPackageFilter(
  storedFile: string,
  packageLabel: string,
  filter: string,
): boolean {
  if (packageLabel === filter) return true;
  const posixFile = posixIndexPath(storedFile);
  const posixFilter = posixIndexPath(filter.trim());
  if (!posixFilter) return false;
  return (
    posixFile === posixFilter ||
    posixFile.endsWith(`/${posixFilter}`) ||
    posixFile.includes(`/${posixFilter}/`)
  );
}

export function assignRefsToSymbols(refs: Ref[], symbols: IndexSymbol[]): Ref[] {
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
 * Resolve the per-project index directory. By default it lives under the
 * global project dir (`~/.wrongstack/projects/<hash>/codebase-index`).
 */
export function resolveIndexDir(projectRoot: string, override?: string): string {
  return override ?? resolveWstackPaths({ projectRoot }).projectCodebaseIndex;
}

/**
 * Optional index-directory override carried on the run context's `meta` bag.
 */
export function codebaseIndexDirOverride(ctx: {
  meta?: Record<string, unknown>;
}): string | undefined {
  const v = ctx.meta?.['codebaseIndexDir'];
  return typeof v === 'string' ? v : undefined;
}
