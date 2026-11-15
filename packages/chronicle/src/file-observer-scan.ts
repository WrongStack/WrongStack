/** Project scanning and file fingerprinting for the Chronicle file observer. */

import { createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { mapWithConcurrency } from '@wrongstack/core/storage';
import type { FileFingerprint } from './file-observer-types.js';

const SCAN_HASH_CONCURRENCY = 32;

export async function scanProject(
  root: string,
  excluded: ReadonlySet<string>,
  excludedPaths: ReadonlySet<string>,
  maxHashBytes: number,
  onError?: ((error: unknown) => void) | undefined,
  previous?: ReadonlyMap<string, FileFingerprint> | undefined,
): Promise<{ files: Map<string, FileFingerprint>; complete: boolean }> {
  const result = new Map<string, FileFingerprint>();
  const dirs = [''];
  let complete = true;
  while (dirs.length > 0) {
    const relativeDir = dirs.pop()!;
    try {
      const entries = await fsp.readdir(path.join(root, relativeDir), { withFileTypes: true });
      const filePaths: string[] = [];
      for (const entry of entries) {
        const relative = normalizeRelative(path.join(relativeDir, entry.name));
        if (isExcluded(relative, excluded, excludedPaths)) continue;
        if (entry.isDirectory()) {
          dirs.push(relative);
        } else if (entry.isFile()) {
          filePaths.push(relative);
        }
      }
      const fingerprints = await mapWithConcurrency(
        filePaths,
        SCAN_HASH_CONCURRENCY,
        async (relative): Promise<[string, FileFingerprint] | null> => {
          try {
            const value = await fingerprint(
              path.join(root, relative),
              maxHashBytes,
              previous?.get(relative),
            );
            return value ? [relative, value] : null;
          } catch (error) {
            complete = false;
            onError?.(error);
            return null;
          }
        },
      );
      for (const entry of fingerprints) {
        if (entry) result.set(entry[0], entry[1]);
      }
    } catch (error) {
      complete = false;
      onError?.(error);
    }
  }
  return { files: result, complete };
}

export async function fingerprint(
  filePath: string,
  maxHashBytes: number,
  previous?: FileFingerprint | undefined,
): Promise<FileFingerprint | undefined> {
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) return undefined;
    const base: FileFingerprint = { size: stat.size, mtimeMs: stat.mtimeMs };
    // Unchanged size+mtime → reuse the known content hash instead of
    // re-reading the file. Full rescans over a quiet tree become stat-only.
    if (
      previous?.hash !== undefined &&
      previous.size === stat.size &&
      previous.mtimeMs === stat.mtimeMs
    ) {
      base.hash = previous.hash;
      return base;
    }
    if (stat.size <= maxHashBytes) {
      base.hash = createHash('sha256')
        .update(await fsp.readFile(filePath))
        .digest('hex');
    }
    return base;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
      return undefined;
    throw error;
  }
}

export function sameFingerprint(
  a: FileFingerprint | undefined,
  b: FileFingerprint | undefined,
): boolean {
  if (!a || !b) return a === b;
  if (a.hash !== undefined && b.hash !== undefined) return a.hash === b.hash;
  return a.size === b.size && a.mtimeMs === b.mtimeMs;
}

export function isExcluded(
  relative: string,
  excluded: ReadonlySet<string>,
  excludedPaths: ReadonlySet<string>,
): boolean {
  const normalized = normalizeRelative(relative);
  if (normalized.split('/').some((segment) => excluded.has(segment))) return true;
  for (const prefix of excludedPaths) {
    if (normalized === prefix || normalized.startsWith(`${prefix}/`)) return true;
  }
  return false;
}

export function normalizeExcludedPaths(root: string, values: readonly string[]): Set<string> {
  const result = new Set<string>();
  for (const value of values) {
    const rawRelative = path.isAbsolute(value) ? path.relative(root, path.resolve(value)) : value;
    const normalized = normalizeRelative(rawRelative).replace(/\/+$/u, '');
    if (
      !normalized ||
      normalized === '.' ||
      normalized === '..' ||
      normalized.startsWith('../') ||
      path.isAbsolute(rawRelative)
    ) {
      continue;
    }
    result.add(normalized);
  }
  return result;
}

export function normalizeRelative(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '');
}

export function resourceId(relativePath: string): string {
  return `file_${createHash('sha256').update(normalizeRelative(relativePath)).digest('hex').slice(0, 24)}`;
}

export function unionKeys(
  a: ReadonlyMap<string, unknown>,
  b: ReadonlyMap<string, unknown>,
): string[] {
  return [...new Set([...a.keys(), ...b.keys()])];
}
