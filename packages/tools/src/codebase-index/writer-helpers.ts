import { resolveWstackPaths } from '@wrongstack/core/utils';
import type { Ref, Symbol as IndexSymbol } from './schema.js';

export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
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
